/**
 * 带工具调用的流式协议适配层。
 *
 * 和 llm.mjs 的分工：
 *   llm.mjs       —— 纯文本流式（测试连接、无工具的简单对话）
 *   toolchat.mjs  —— 这里，支持 function calling 的完整轮次
 *
 * 内部消息用**中立格式**，两个协议各自翻译：
 *   { role:'system'|'user'|'assistant'|'tool', content:string,
 *     toolCalls?: [{id,name,args}],   // assistant 要求调用工具
 *     toolCallId?: string }           // tool 的返回结果
 *
 * 对外产出的事件：
 *   { type:'delta',      text }                      文本增量
 *   { type:'tool_calls', calls:[{id,name,args}] }    模型要求调用工具
 *   { type:'done',       stopReason }                本轮结束
 *   { type:'error',      short, hint }               出错
 */

import { joinUrl, translateError, translateNetworkError } from '../llm.mjs'
import { toOpenAITools, toAnthropicTools } from './tools.mjs'

/* ---------------- 消息格式转换 ---------------- */

function stringifyArgs (args) {
  if (typeof args === 'string') return args
  try { return JSON.stringify(args || {}) } catch { return '{}' }
}

function toOpenAIMessages (messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: stringifyArgs(c.args) }
        }))
      })
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || '',
        content: String(m.content == null ? '' : m.content)
      })
    } else {
      out.push({ role: m.role, content: String(m.content == null ? '' : m.content) })
    }
  }
  return out
}

function toAnthropicMessages (messages) {
  const system = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n')
  const out = []
  let pendingToolResults = []

  const flushToolResults = () => {
    if (!pendingToolResults.length) return
    out.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // 连续的 tool 结果要合并成同一条 user 消息（Anthropic 要求如此）
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId || '',
        content: String(m.content == null ? '' : m.content)
      })
      continue
    }

    flushToolResults()

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      const content = []
      if (m.content) content.push({ type: 'text', text: String(m.content) })
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} })
      }
      out.push({ role: 'assistant', content })
    } else {
      out.push({ role: m.role, content: String(m.content == null ? '' : m.content) })
    }
  }
  flushToolResults()
  return { system, messages: out }
}

/* ---------------- 请求构造 ---------------- */

function buildRequest ({ api, baseURL, apiKey, model, messages, tools, maxTokens, temperature, stream }) {
  const hasTools = Array.isArray(tools) && tools.length > 0

  if (api === 'anthropic') {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    }
    if (apiKey) headers['x-api-key'] = apiKey
    const { system, messages: msgs } = toAnthropicMessages(messages)
    const body = {
      model,
      max_tokens: Math.max(1, Number(maxTokens) || 4096),
      messages: msgs
    }
    if (system) body.system = system
    if (hasTools) body.tools = toAnthropicTools(tools)
    if (temperature !== undefined) body.temperature = Number(temperature)
    if (stream) body.stream = true
    return { url: joinUrl(baseURL, 'messages'), headers, body }
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
  const body = {
    model,
    messages: toOpenAIMessages(messages),
    max_tokens: Math.max(1, Number(maxTokens) || 4096)
  }
  if (hasTools) {
    body.tools = toOpenAITools(tools)
    body.tool_choice = 'auto'
  }
  if (temperature !== undefined) body.temperature = Number(temperature)
  if (stream) body.stream = true
  return { url: joinUrl(baseURL, 'chat/completions'), headers, body }
}

/* ---------------- 参数解析（模型偶尔吐坏 JSON） ---------------- */

function parseArgs (raw) {
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return { __raw: String(raw), __parseFailed: true } }
}

/* ---------------- 主函数 ---------------- */

export async function* streamTurn ({
  api,
  baseURL,
  apiKey,
  model,
  messages,
  tools,
  maxTokens,
  temperature,
  timeoutMs = 180000
}) {
  const req = buildRequest({ api, baseURL, apiKey, model, messages, tools, maxTokens, temperature, stream: true })
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
      yield { type: 'error', status: res.status, ...translateError(res.status, text) }
      return
    }

    if (!res.body || !res.body.getReader) {
      const text = await res.text()
      let parsed = {}
      try { parsed = JSON.parse(text) } catch { /* 保底 */ }
      const out = api === 'anthropic' ? readAnthropicFull(parsed) : readOpenAIFull(parsed)
      if (out.text) yield { type: 'delta', text: out.text }
      if (out.calls.length) yield { type: 'tool_calls', calls: out.calls }
      yield { type: 'done', stopReason: out.stopReason }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    const state = api === 'anthropic' ? newAnthropicState() : newOpenAIState()

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of chunk.split('\n')) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          const payload = s.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let json
          try { json = JSON.parse(payload) } catch { continue }
          if (json.error) {
            yield { type: 'error', ...translateError(500, JSON.stringify(json.error)) }
            continue
          }
          for (const evt of api === 'anthropic' ? feedAnthropic(state, json) : feedOpenAI(state, json)) {
            yield evt
          }
        }
      }
    }

    // 流结束：把累积的工具调用吐出来
    const truncated = state.stopReason === 'length'
    const calls = state.toolOrder.map(k => state.tools.get(k)).filter(Boolean).map(t => ({
      id: t.id,
      name: t.name,
      args: parseArgs(t.rawArgs)
    })).filter(c => c.name)

    if (calls.length) {
      // 被长度上限截断时，工具参数是**生成到一半的 JSON**，拿去执行只会出怪事。
      // 这里直接拦下来，给一条能照着改的提示，而不是让模型收到一个坏参数。
      if (truncated) {
        yield {
          type: 'error',
          short: '输出到了长度上限，工具参数没生成完',
          hint: '请在「模型设置」里把「最大输出长度」调大，或者把任务拆小一点再试。'
        }
        return
      }
      yield { type: 'tool_calls', calls }
    }
    yield { type: 'done', stopReason: state.stopReason || (calls.length ? 'tool_calls' : 'stop') }
  } catch (e) {
    yield { type: 'error', ...translateNetworkError(e) }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- OpenAI 流式累积 ---------------- */

function newOpenAIState () {
  return { text: '', tools: new Map(), toolOrder: [], stopReason: '' }
}

function feedOpenAI (state, json) {
  const events = []
  const ch = json.choices && json.choices[0]
  if (!ch) return events

  const d = ch.delta || {}
  if (d.content) {
    state.text += d.content
    events.push({ type: 'delta', text: d.content })
  }
  if (Array.isArray(d.tool_calls)) {
    for (const tc of d.tool_calls) {
      const key = tc.index == null ? 0 : tc.index
      if (!state.tools.has(key)) {
        state.tools.set(key, { id: tc.id || ('call_' + key), name: '', rawArgs: '' })
        state.toolOrder.push(key)
      }
      const slot = state.tools.get(key)
      if (tc.id) slot.id = tc.id
      if (tc.function && tc.function.name) slot.name = tc.function.name
      if (tc.function && tc.function.arguments) slot.rawArgs += tc.function.arguments
    }
  }
  if (ch.finish_reason) state.stopReason = ch.finish_reason
  return events
}

function readOpenAIFull (json) {
  const ch = (json.choices && json.choices[0]) || {}
  const msg = ch.message || {}
  const calls = (msg.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function && tc.function.name,
    args: parseArgs(tc.function && tc.function.arguments)
  }))
  return { text: msg.content || '', calls, stopReason: ch.finish_reason || 'stop' }
}

/* ---------------- Anthropic 流式累积 ---------------- */

function newAnthropicState () {
  return { text: '', tools: new Map(), toolOrder: [], stopReason: '', blockKind: new Map() }
}

function feedAnthropic (state, json) {
  const events = []
  const t = json.type

  if (t === 'content_block_start') {
    const b = json.content_block || {}
    state.blockKind.set(json.index, b.type)
    if (b.type === 'tool_use') {
      state.tools.set(json.index, { id: b.id || ('toolu_' + json.index), name: b.name || '', rawArgs: '' })
      state.toolOrder.push(json.index)
    }
  } else if (t === 'content_block_delta') {
    const d = json.delta || {}
    if (d.type === 'text_delta' && d.text) {
      state.text += d.text
      events.push({ type: 'delta', text: d.text })
    } else if (d.type === 'input_json_delta') {
      const slot = state.tools.get(json.index)
      if (slot && d.partial_json) slot.rawArgs += d.partial_json
    }
  } else if (t === 'message_delta') {
    const d = json.delta || {}
    if (d.stop_reason) state.stopReason = d.stop_reason
  } else if (t === 'error') {
    events.push({ type: 'error', ...translateError(500, JSON.stringify(json.error || json)) })
  }
  return events
}

function readAnthropicFull (json) {
  const blocks = json.content || []
  let text = ''
  const calls = []
  for (const b of blocks) {
    if (b.type === 'text') text += b.text || ''
    else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: b.input || {} })
  }
  return { text, calls, stopReason: json.stop_reason || 'end_turn' }
}
