/**
 * 模型适配层。
 *
 * 两种协议：
 *   openai     POST {base}/chat/completions   Authorization: Bearer <key>
 *   anthropic  POST {base}/messages           x-api-key + anthropic-version
 *
 * 错误信息必须翻译成人话 —— 这是开源工具的口碑所在。
 * 用户看到 "401" 会放弃，看到 "API Key 无效或已过期" 会去改。
 */

/* ---------------- 错误翻译 ---------------- */

export function translateError(status, bodyText, providerName) {
  const name = providerName || '厂商'
  const raw = String(bodyText || '').slice(0, 400)
  const lower = raw.toLowerCase()

  if (status === 401) return { short: 'API Key 无效或已过期', hint: '重新复制 Key，注意首尾不要带空格或换行。' }
  if (status === 403) return { short: '这个 Key 没有访问该模型的权限', hint: '确认账号已开通对应模型，或换一个模型试试。' }
  if (status === 404) return { short: 'baseURL 或模型名不对', hint: '地址一般要填到 /v1 为止；模型名拼写要和厂商文档一致。' }
  if (status === 422) return { short: '请求参数不被接受', hint: '多半是模型名不对。' }
  if (status === 429) {
    if (lower.includes('quota') || lower.includes('balance') || lower.includes('insufficient')) {
      return { short: '余额不足', hint: '去厂商控制台充值。' }
    }
    return { short: '触发限流', hint: '请求太频繁，等几秒再试。' }
  }
  if (status === 400) return { short: '请求被拒绝', hint: '最常见的原因是模型名不对，其次是参数超限。' }
  if (status >= 500) return { short: `${name} 服务端错误（${status}）`, hint: '不是你的问题，稍后重试。' }
  return { short: `请求失败（HTTP ${status}）`, hint: raw.slice(0, 200) }
}

export function translateNetworkError(err) {
  const msg = String(err && err.message || err)
  if (/abort|timeout|timed out/i.test(msg)) {
    return { short: '连接超时', hint: '网络不通，或该厂商在国内需要代理。' }
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg)) {
    return { short: '域名解析失败', hint: '检查 baseURL 拼写和本机网络。' }
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return { short: '连接被拒绝', hint: '地址或端口不对；如果用 Ollama，确认它已经启动。' }
  }
  if (/certificate|SSL|TLS/i.test(msg)) {
    return { short: 'TLS 证书错误', hint: '可能有代理在中间拦截，或系统时间不对。' }
  }
  return { short: '网络请求失败', hint: msg.slice(0, 200) }
}

/* ---------------- URL 拼接 ---------------- */

export function joinUrl(base, suffix) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  const s = String(suffix || '').replace(/^\/+/, '')
  return b + '/' + s
}

/* ---------------- 拉取厂商真实可用的模型列表 ----------------
 *
 * 为什么需要它：候选项是我们硬编码的，厂商出了新模型用户就得手打准确名字。
 * 「自己选喜欢的模型」这个要求，靠硬编码的候选列表是做不到位的。
 *
 * OpenAI 兼容的网关有标准的 GET /models；Anthropic 也有 /v1/models。
 * 但不是所有网关都实现，所以失败时**不报错、返回空**，界面上退回预设候选。
 */
export async function listModels ({ api, baseURL, apiKey, timeoutMs = 15000 }) {
  if (!baseURL) return { ok: false, short: '还没填接口地址', models: [] }

  const headers = {}
  if (api === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
  } else if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(joinUrl(baseURL, 'models'), { headers, signal: ctl.signal })
    const text = await res.text()
    if (!res.ok) {
      const t = translateError(res.status, text)
      return { ok: false, ...t, models: [] }
    }
    let parsed = {}
    try { parsed = JSON.parse(text) } catch { /* 有的网关返回的不是 JSON */ }
    const rows = Array.isArray(parsed.data) ? parsed.data
      : (Array.isArray(parsed.models) ? parsed.models : [])
    const models = rows
      .map(r => (typeof r === 'string' ? r : (r && (r.id || r.name))))
      .filter(Boolean)
      .map(String)
      .sort()
    return { ok: true, models, count: models.length }
  } catch (e) {
    return { ok: false, ...translateNetworkError(e), models: [] }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 请求构造 ---------------- */

function buildRequest({ api, baseURL, apiKey, model, messages, stream, maxTokens, temperature }) {
  if (api === 'anthropic') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    }
    if (apiKey) headers['x-api-key'] = apiKey
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
    const body = {
      model,
      max_tokens: Math.max(1, Number(maxTokens) || 1024),
      messages: rest
    }
    if (sys) body.system = sys
    if (temperature !== undefined) body.temperature = Number(temperature)
    if (stream) body.stream = true
    return { url: joinUrl(baseURL, 'messages'), headers, body }
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  const body = {
    model,
    messages,
    max_tokens: Math.max(1, Number(maxTokens) || 1024)
  }
  if (temperature !== undefined) body.temperature = Number(temperature)
  if (stream) body.stream = true
  return { url: joinUrl(baseURL, 'chat/completions'), headers, body }
}

/* ---------------- 取增量文本 ---------------- */

function extractDelta(api, json) {
  try {
    if (api === 'anthropic') {
      if (json.type === 'content_block_delta' && json.delta) return json.delta.text || ''
      return ''
    }
    const ch = json.choices && json.choices[0]
    if (!ch) return ''
    return (ch.delta && ch.delta.content) || ''
  } catch {
    return ''
  }
}

function extractFullText(api, json) {
  try {
    if (api === 'anthropic') {
      return (json.content || []).map(c => c.text || '').join('')
    }
    const ch = json.choices && json.choices[0]
    return (ch && ch.message && ch.message.content) || ''
  } catch {
    return ''
  }
}

/* ---------------- 测试连接 ---------------- */

export async function testConnection({ api, baseURL, apiKey, model, providerName, timeoutMs = 25000 }) {
  if (!baseURL) {
    return { ok: false, short: '还没填 baseURL', hint: '选一个厂商预设会自动填好；自定义则需要手工填。' }
  }
  if (!model) {
    return { ok: false, short: '还没填模型名', hint: '从候选里选一个，或照厂商文档填。' }
  }

  const req = buildRequest({
    api, baseURL, apiKey, model,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
    maxTokens: 1,
    temperature: 0
  })

  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctl.signal
    })
    const text = await res.text()
    const latencyMs = Date.now() - started
    if (!res.ok) {
      const t = translateError(res.status, text, providerName)
      return { ok: false, status: res.status, latencyMs, ...t, raw: text.slice(0, 400) }
    }
    let parsed = {}
    try { parsed = JSON.parse(text) } catch { /* 某些网关返回非 JSON */ }
    const reply = extractFullText(api, parsed)
    return {
      ok: true,
      status: res.status,
      latencyMs,
      short: '连接成功',
      hint: reply ? '模型回应：' + reply.slice(0, 40) : '厂商已接受请求。',
      model: parsed.model || model
    }
  } catch (e) {
    const latencyMs = Date.now() - started
    const t = translateNetworkError(e)
    return { ok: false, latencyMs, ...t, raw: String(e && e.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 流式对话 ---------------- */

/**
 * 逐块产出文本增量。
 * 用 async generator，调用方（HTTP 层）负责转成 SSE 推给前端。
 */
export async function* streamChat({ api, baseURL, apiKey, model, messages, maxTokens, temperature, timeoutMs = 120000 }) {
  const req = buildRequest({ api, baseURL, apiKey, model, messages, stream: true, maxTokens, temperature })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctl.signal
    })

    if (!res.ok) {
      const text = await res.text()
      const t = translateError(res.status, text)
      yield { type: 'error', status: res.status, ...t }
      return
    }

    if (!res.body) {
      // 极少数情况没有流式响应体，退化为一次性读取
      const text = await res.text()
      let parsed = {}
      try { parsed = JSON.parse(text) } catch {}
      yield { type: 'delta', text: extractFullText(api, parsed) }
      yield { type: 'done' }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let json
          try { json = JSON.parse(payload) } catch { continue }
          if (json.error) {
            yield { type: 'error', ...translateError(500, JSON.stringify(json.error)) }
            continue
          }
          const delta = extractDelta(api, json)
          if (delta) yield { type: 'delta', text: delta }
        }
      }
    }

    yield { type: 'done' }
  } catch (e) {
    const t = translateNetworkError(e)
    yield { type: 'error', ...t }
  } finally {
    clearTimeout(timer)
  }
}
