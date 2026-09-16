/**
 * 换行分隔的 JSON-RPC 2.0 传输 —— DSH SDK 协议的底座。
 *
 * 为什么自己实现而不用 @deepseek-ai/dsh-sdk-protocol：
 *   本地服务一直坚持零第三方依赖。这个协议本身很小（对方实现也就 250 行），
 *   自己写一份既省掉依赖，也让 DSH 变成**可选**后端而不是硬依赖。
 *
 * 流是**注入**的：生产环境接子进程的 stdio，测试时接内存流。
 * 这样即使开发环境禁止创建子进程管道，协议层依然可以完整测试。
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export class JsonRpcError extends Error {
  constructor (code, message, data) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}

export class JsonRpcLineTransport {
  constructor (input, output) {
    this.input = input
    this.output = output
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.started = false
    this.closed = false
    this.requestHandler = null
    this.notificationHandler = null
    this.pending = new Map()
    this._onData = chunk => {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
      this._drain()
    }
    this._onError = err => this._failPending(err)
    this._onEnd = () => {
      this.buffer += this.decoder.end()
      this._drain()
      this._failPending(new Error('JSON-RPC 输入流已关闭'))
    }
  }

  start () {
    if (this.started) return
    this.started = true
    this.input.on('data', this._onData)
    this.input.on('error', this._onError)
    this.input.on('end', this._onEnd)
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this._onData)
    this.input.off('error', this._onError)
    this.input.off('end', this._onEnd)
    this._failPending(new Error('JSON-RPC 传输已关闭'))
  }

  onRequest (handler) { this.requestHandler = handler }
  onNotification (handler) { this.notificationHandler = handler }

  request (method, params, signal) {
    const id = 'req_' + randomUUID().replace(/-/g, '')
    return new Promise((resolve, reject) => {
      let detach = () => {}
      if (signal) {
        if (signal.aborted) { reject(abortError(signal.reason)); return }
        const onAbort = () => { this.pending.delete(id); reject(abortError(signal.reason)) }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        resolve: v => { detach(); resolve(v) },
        reject: e => { detach(); reject(e) }
      })
      try {
        this._write(params === undefined
          ? { jsonrpc: '2.0', id, method }
          : { jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        detach()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  notify (method, params) {
    this._write(params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params })
  }

  _write (message) {
    if (this.closed) throw new Error('JSON-RPC 传输已关闭，无法写入')
    this.output.write(JSON.stringify(message) + '\n')
  }

  _drain () {
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      this._handleLine(line)
    }
  }

  async _handleLine (line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }   // 坏行直接忽略，不能崩
    if (!msg || typeof msg !== 'object') return

    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
    const hasMethod = typeof msg.method === 'string'
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}

    if (hasId && hasMethod) {
      const handler = this.requestHandler
      if (!handler) { this._writeError(msg.id, -32601, 'method not found: ' + msg.method); return }
      try {
        const result = await handler(msg.method, params)
        this._write({ jsonrpc: '2.0', id: msg.id, result })
      } catch (e) {
        this._writeError(msg.id, -32603, e instanceof Error ? e.message : String(e))
      }
      return
    }

    if (hasId) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error && typeof msg.error === 'object') {
        p.reject(new JsonRpcError(
          typeof msg.error.code === 'number' ? msg.error.code : undefined,
          typeof msg.error.message === 'string' ? msg.error.message : 'JSON-RPC 错误',
          msg.error.data
        ))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (hasMethod && this.notificationHandler) this.notificationHandler(msg.method, params)
  }

  _writeError (id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  _failPending (error) {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const w of all) w.reject(error)
  }
}

function abortError (reason) {
  return reason instanceof Error ? reason : new Error('JSON-RPC 请求被中止: ' + String(reason))
}
