/**
 * DSH SDK 客户端 —— 说 DSH 的 stdio JSON-RPC 协议。
 *
 * 协议一共三个请求（从 dsh-sdk-jsonrpc-server 的实现里读出来的）：
 *   initialize      { cwd, provider, model, reasoningEffort?, maxTokens? }
 *                   → { serverInfo: { name, version } }
 *   session/prompt  { sessionId, contentBlocks }
 *                   → { messageId }
 *   shutdown        → {}
 *
 * 服务端推来的通知：
 *   session.event      { sessionId, event }        ← 对话流在这里
 *   session.status     { sessionId, status }
 *   subagent.started   { parentSessionId, childSessionId }
 *   subagent.finished  { ..., status, stopReason, lastAssistantMessage? }
 *
 * 流是注入的 —— 生产接子进程 stdio，测试接内存流。
 */

import { JsonRpcLineTransport } from './transport.mjs'

export function createDshClient ({ input, output }) {
  const transport = new JsonRpcLineTransport(input, output)
  const handlers = { event: [], status: [], subagent: [], raw: [] }
  let started = false

  transport.onNotification((method, params) => {
    for (const h of handlers.raw) { try { h(method, params) } catch { /* 观察者出错不影响协议 */ } }
    switch (method) {
      case 'session.event':
        for (const h of handlers.event) { try { h(params) } catch { /* 同上 */ } }
        break
      case 'session.status':
        for (const h of handlers.status) { try { h(params) } catch { /* 同上 */ } }
        break
      case 'subagent.started':
      case 'subagent.finished':
        for (const h of handlers.subagent) { try { h(method, params) } catch { /* 同上 */ } }
        break
      default:
        break
    }
  })

  function on (kind, fn) {
    if (!handlers[kind]) handlers[kind] = []
    handlers[kind].push(fn)
    return () => {
      handlers[kind] = handlers[kind].filter(x => x !== fn)
    }
  }

  return {
    /** 开始读流。幂等。 */
    start () {
      if (started) return
      started = true
      transport.start()
    },

    on,

    /** 握手：告诉 DSH 用哪个 provider / model、工作目录在哪 */
    initialize (params, signal) {
      return transport.request('initialize', {
        cwd: params.cwd,
        provider: params.provider,
        model: params.model,
        ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
        ...(Number.isSafeInteger(params.maxTokens) ? { maxTokens: params.maxTokens } : {})
      }, signal)
    },

    /** 发一条用户消息。contentBlocks 形如 [{type:'text', text:'...'}] */
    prompt (params, signal) {
      return transport.request('session/prompt', {
        sessionId: params.sessionId,
        contentBlocks: params.contentBlocks
      }, signal)
    },

    /** 优雅退出，DSH 会释放它创建的 agent 然后进程退出 */
    shutdown (signal) {
      return transport.request('shutdown', {}, signal)
    },

    /** 不走 request/response 的底层通道，留给以后扩展用 */
    notify: (method, params) => transport.notify(method, params),
    request: (method, params, signal) => transport.request(method, params, signal),

    dispose () { transport.close() }
  }
}
