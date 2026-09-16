/**
 * 模拟模型服务 —— 用来端到端验证工具调用链，不需要真 Key、不花一分钱。
 *
 * 它假装是 OpenAI 兼容的 /v1/chat/completions，行为是脚本化的：
 *   第一轮：返回一个 tool_call（默认 replace_selection）
 *   第二轮（请求里已经带了 tool 结果）：返回一句收尾文本
 *
 * 这样整条链路就能真跑：
 *   模拟模型 → 服务 agent 循环 → SSE 把 tool 事件推给侧栏
 *            → 侧栏用（模拟的）JSAPI 改文档 → POST 结果回来 → 循环继续
 *
 * 用法：node dev/mock-llm.mjs [port]     默认 43199
 */
import http from 'node:http'

const PORT = Number(process.argv[2] || 43199)

/** 每轮要调用的工具，可以用环境变量覆盖，方便测不同分支 */
const PLAN = JSON.parse(process.env.MOCK_PLAN || 'null') || [
  { name: 'replace_selection', args: { text: '改写过的示例文字' } }
]

function sse (res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

/** 最后一次请求的可观测参数，供测试断言 */
let lastRequest = { none: true }

function streamToolCall (res, calls) {
  calls.forEach((c, i) => {
    sse(res, {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: i, id: c.id || ('call_' + i), type: 'function', function: { name: c.name, arguments: '' } }] }
      }]
    })
    sse(res, {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args || {}) } }] }
      }]
    })
  })
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
}

function streamText (res, text) {
  // 故意分几段推，顺便验证客户端的增量拼接
  const chunks = String(text).match(/[\s\S]{1,8}/g) || ['']
  for (const c of chunks) sse(res, { choices: [{ index: 0, delta: { content: c } }] })
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
}

const server = http.createServer((req, res) => {
  // 把最后一次请求的关键参数暴露出来，供测试断言
  // （比如"服务到底把多大的 max_tokens 传给了厂商"）
  if (req.url.startsWith('/last')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(lastRequest))
    return
  }

  // 模型列表：让"拉取列表"这条路径也能端到端测
  if (req.url.startsWith('/v1/models') || req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'mock-model', object: 'model' },
        { id: 'mock-model-mini', object: 'model' },
        { id: 'mock-reasoner', object: 'model' }
      ]
    }))
    return
  }

  if (!req.url.startsWith('/v1/chat/completions') && !req.url.startsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'mock: 只实现 /v1/chat/completions' } }))
    return
  }

  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { /* 忽略 */ }
    const messages = payload.messages || []
    const toolResults = messages.filter(m => m.role === 'tool').length
    const toolsOffered = (payload.tools || []).map(t => t.function && t.function.name)

    lastRequest = {
      max_tokens: payload.max_tokens,
      temperature: payload.temperature,
      model: payload.model,
      messageCount: messages.length,
      toolCount: toolsOffered.length,
      at: new Date().toISOString()
    }

    console.log(`[mock-llm] 请求：${messages.length} 条消息，已收到 ${toolResults} 个工具结果，max_tokens=${payload.max_tokens}`)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    // 按"已收到几个工具结果"决定这一步该干什么 —— 这样能验证多步循环
    const step = PLAN[toolResults]
    if (step && step.name !== '__none__' && toolsOffered.includes(step.name)) {
      console.log(`[mock-llm] → 第 ${toolResults + 1} 步：调用 ${step.name}`)
      streamToolCall(res, [step])
      res.end()
      return
    }

    console.log('[mock-llm] → 返回文本')
    streamText(res, '好了，已经按你说的改完了。')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] 已启动 http://127.0.0.1:${PORT}/v1  （计划：${PLAN.map(p => p.name).join(', ')}）`)
})
