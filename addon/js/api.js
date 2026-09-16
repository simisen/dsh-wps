/* ============================================================
 * 与本地服务通信。
 *
 * 关键点：加载项页面**本身就是这个服务托管的**，所以 location.origin
 * 就是服务地址 —— 同源，用相对路径即可，既不需要端口发现，也不需要 CORS。
 *
 * 用原生 XMLHttpRequest 而不是 WpsInvoke.CreateXHR()：
 * 实测 WPS 12.1 上 WpsInvoke 是 undefined，官方示例里那个写法会直接报错。
 * ============================================================ */

var DSH = (function () {
  function request(method, path, body, cb) {
    var x
    try {
      x = new XMLHttpRequest()
    } catch (e) {
      cb({ ok: false, short: '无法创建网络请求', hint: String(e) })
      return
    }
    var done = false
    var timer = setTimeout(function () {
      if (done) return
      done = true
      cb({ ok: false, short: '服务无响应', hint: '本地服务可能已经退出了，重新启动它再试。' })
    }, 30000)

    try {
      x.open(method, path, true)
      x.onreadystatechange = function () {
        if (done || x.readyState !== 4) return
        done = true
        clearTimeout(timer)
        var parsed = null
        try { parsed = JSON.parse(x.responseText) } catch (e) { /* 保留 null */ }
        if (parsed) cb(parsed)
        else cb({ ok: false, short: '服务返回了无法解析的内容', hint: 'HTTP ' + x.status })
      }
      x.onerror = function () {
        if (done) return
        done = true
        clearTimeout(timer)
        cb({ ok: false, short: '连不上本地服务', hint: '确认那个命令行窗口还开着。' })
      }
      if (body !== undefined && body !== null) {
        x.setRequestHeader('Content-Type', 'application/json')
        x.send(JSON.stringify(body))
      } else {
        x.send()
      }
    } catch (e) {
      clearTimeout(timer)
      if (!done) { done = true; cb({ ok: false, short: '请求发送失败', hint: String(e) }) }
    }
  }

  return {
    ping: function (cb) { request('GET', '/api/ping', null, cb) },
    providers: function (cb) { request('GET', '/api/providers', null, cb) },
    getConfig: function (cb) { request('GET', '/api/config', null, cb) },
    saveConfig: function (payload, cb) { request('POST', '/api/config', payload, cb) },
    test: function (payload, cb) { request('POST', '/api/test', payload, cb) },
    models: function (payload, cb) { request('POST', '/api/models', payload, cb) },

    /* 流式对话：fetch + ReadableStream 读 SSE。Chromium 104 支持。
       所有事件统一走 onEvent，由调用方分发：
         turn / status / delta / tool / tool_result / end / error  */
    chat: function (payload, onEvent) {
      onEvent = onEvent || function () {}
      var ctl = null
      try { ctl = new AbortController() } catch (e) { /* 老内核没有就用不了中断 */ }

      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl ? ctl.signal : undefined
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var parsed = null
            try { parsed = JSON.parse(t) } catch (e) {}
            onEvent(parsed && parsed.short
              ? { type: 'error', short: parsed.short, hint: parsed.hint }
              : { type: 'error', short: '请求失败 HTTP ' + res.status })
          })
        }
        if (!res.body || !res.body.getReader) {
          return res.text().then(function (t) {
            onEvent({ type: 'delta', text: t })
            onEvent({ type: 'end' })
          })
        }
        var reader = res.body.getReader()
        var decoder = new TextDecoder('utf-8')
        var buffer = ''

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { onEvent({ type: 'eof' }); return }
            buffer += decoder.decode(r.value, { stream: true })
            var idx
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              var chunk = buffer.slice(0, idx)
              buffer = buffer.slice(idx + 2)
              var lines = chunk.split('\n')
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim()
                if (line.indexOf('data:') !== 0) continue
                var raw = line.slice(5).trim()
                if (!raw) continue
                var evt = null
                try { evt = JSON.parse(raw) } catch (e) { continue }
                onEvent(evt)
              }
            }
            return pump()
          })
        }
        return pump()
      }).catch(function (e) {
        if (String(e && e.name) === 'AbortError') { onEvent({ type: 'eof', aborted: true }); return }
        onEvent({ type: 'error', short: '网络中断', hint: String(e && e.message || e) })
      })

      return { abort: function () { try { ctl && ctl.abort() } catch (e) {} } }
    },

    /* 把工具执行结果送回服务端 —— agent 循环在等这个才会继续 */
    toolResult: function (payload, cb) {
      request('POST', '/api/tool-result', payload, cb || function () {})
    }
  }
})()

/* 跨窗口通信：配置悬浮框保存后通知侧栏刷新。
   实测 BroadcastChannel 在加载项各页面之间双向可用（同源）。 */
var DSH_BUS = (function () {
  var ch = null
  try { ch = new BroadcastChannel('dsh-wps') } catch (e) { ch = null }
  return {
    /* 返回 true 表示消息确实发出去了。
       调用方需要用它来判断"这条路通不通"，否则会重复执行。 */
    post: function (msg) {
      if (!ch) return false
      try { ch.postMessage(msg); return true } catch (e) { return false }
    },
    on: function (fn) {
      if (!ch) return
      ch.onmessage = function (ev) { try { fn(ev.data || {}) } catch (e) {} }
    }
  }
})()
