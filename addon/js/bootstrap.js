/* 前端错误上报：WPS 里开不了 DevTools，加载项主上下文报的错也得能回传。 */
;(function () {
  function report(o) {
    try {
      o.where = 'addin-main'
      var x = new XMLHttpRequest()
      x.open('POST', '/api/clientlog', true)
      x.setRequestHeader('Content-Type', 'application/json')
      x.send(JSON.stringify(o))
    } catch (e) { /* 忽略 */ }
  }
  window.onerror = function (msg, src, line, col, err) {
    report({ message: String(msg), src: String(src || ''), line: line, col: col, stack: err && err.stack })
  }
})()

/* 轻量追踪：把"走到哪一步了"回传到服务端。
   WPS 里开不了 DevTools，而加载项失败往往是**完全静默**的
   （比如 ribbon.xml 被拒 → OnAddinLoad 压根不触发），
   没有这条通道就只能靠猜。 */
function dshTrace(msg) {
  try {
    var x = new XMLHttpRequest()
    x.open('POST', '/api/clientlog', true)
    x.setRequestHeader('Content-Type', 'application/json')
    x.send(JSON.stringify({ where: 'addin-main', message: '[trace] ' + msg }))
  } catch (e) { /* 追踪失败不能影响主流程 */ }
}

/* ============================================================
 * WPS 加载项引导：Ribbon 回调、侧栏与悬浮窗的开关、首次使用引导。
 *
 * 面板选型（已实测确认）：
 *   聊天  → CreateTaskPane，停靠侧栏。高频使用，不遮挡文档。
 *   配置  → ShowDialog(..., false)，非模态悬浮窗。低频使用，填完可关、随时重开。
 *
 * 注意：WPS 对加载项做了进程/COM 沙箱，加载项无法启动外部进程
 * （实测 CoCreateInstance('WScript.Shell') 会报 "can not create"）。
 * 所以本地服务必须由外部启动（安装脚本注册自启），这里只能检测并友好提示。
 * ============================================================ */

var DSH_UI = {
  chatPaneId: null,
  settingsOpen: false,
  serviceOk: false,
  booted: false
}

/* ---------------- 基础工具 ---------------- */

function dshEnsureEnum() {
  try {
    if (typeof window.Application.Enum !== 'object') {
      window.Application.Enum = {
        msoCTPDockPositionLeft: 0,
        msoCTPDockPositionRight: 2
      }
    }
  } catch (e) { /* 忽略 */ }
}

function dshUrl(rel) {
  return location.origin + rel
}

function dshStorage(key, value) {
  try {
    var ps = window.Application.PluginStorage
    if (arguments.length === 1) return ps.getItem(key)
    ps.setItem(key, value)
  } catch (e) { return null }
}

/* ---------------- 侧栏 ---------------- */

function dshToggleChat() {
  var app = window.Application
  var id = dshStorage('dsh_chat_pane_id')
  try {
    if (!id) {
      var pane = app.CreateTaskPane(dshUrl('/ui/chat.html'))
      dshStorage('dsh_chat_pane_id', pane.ID)
      dshEnsureEnum()
      try { pane.DockPosition = app.Enum.msoCTPDockPositionRight } catch (e) {}
      pane.Visible = true
    } else {
      var p = app.GetTaskPane(id)
      p.Visible = !p.Visible
    }
    dshInvalidate('btnToggleChat')
  } catch (e) {
    alert('打开侧栏失败：' + (e && e.message ? e.message : e))
  }
}

function dshOpenChat() {
  var app = window.Application
  var id = dshStorage('dsh_chat_pane_id')
  try {
    if (!id) {
      dshTrace('CreateTaskPane 调用中…')
      var pane = app.CreateTaskPane(dshUrl('/ui/chat.html'))
      dshStorage('dsh_chat_pane_id', pane.ID)
      dshEnsureEnum()
      try { pane.DockPosition = app.Enum.msoCTPDockPositionRight } catch (e) {}
      pane.Visible = true
      dshTrace('侧栏创建成功 ID=' + pane.ID)
      return
    }
    app.GetTaskPane(id).Visible = true
    dshTrace('复用已有侧栏 ID=' + id)
  } catch (e) {
    // 以前这里是静默吞掉的，结果失败了一点线索都没有
    dshTrace('CreateTaskPane 失败: ' + (e && e.message ? e.message : e))
  }
}

function dshChatVisible() {
  try {
    var id = dshStorage('dsh_chat_pane_id')
    if (!id) return false
    return !!window.Application.GetTaskPane(id).Visible
  } catch (e) { return false }
}

/* ---------------- 配置悬浮窗 ---------------- */

var DSH_LAST_SETTINGS_AT = 0

function dshOpenSettings() {
  // 防抖：同一次用户操作若从两条路进来（Ribbon 按钮 + 侧栏广播），只开一个窗口。
  // 之前踩过：侧栏的"兜底"和广播同时生效，开出两个一模一样的设置窗。
  var now = Date.now()
  if (now - DSH_LAST_SETTINGS_AT < 800) return
  DSH_LAST_SETTINGS_AT = now
  try {
    // 最后一个参数 false = 非模态，这是一个可移动、可关闭的独立窗口
    window.Application.ShowDialog(dshUrl('/ui/settings.html'), 'DSH 模型设置', 560, 700, false)
  } catch (e) {
    alert('打开设置失败：' + (e && e.message ? e.message : e))
  }
}

function dshInvalidate(controlId) {
  try {
    if (controlId) window.Application.ribbonUI.InvalidateControl(controlId)
    else window.Application.ribbonUI.Invalidate()
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 首次引导 ---------------- */

function dshBoot() {
  if (DSH_UI.booted) return
  DSH_UI.booted = true
  dshTrace('boot 开始 typeof_Application=' + (typeof window.Application))
  DSH.ping(function (r) {
    DSH_UI.serviceOk = !!(r && r.ok)
    dshTrace('ping 完成 serviceOk=' + DSH_UI.serviceOk)
    // 先无条件把侧栏打开 —— 即使服务没起来，也要让用户看到发生什么
    dshOpenChat()

    if (!DSH_UI.serviceOk) return

    DSH.getConfig(function (cfg) {
      if (cfg && cfg.ok === false) { dshTrace('getConfig 返回错误'); return }
      dshTrace('配置读取完成 hasKey=' + (cfg && cfg.hasKey))
      // 首次使用：还没配 Key，直接把设置悬浮窗弹出来，别让用户对着空白面板发呆
      if (!cfg || !cfg.hasKey) {
        setTimeout(dshOpenSettings, 500)
      }
    })
  })
}

/* ---------------- Ribbon 回调 ---------------- */

// 这是整个加载项里第一个被执行的函数
function OnAddinLoad(ribbonUI) {
  try {
    if (typeof window.Application.ribbonUI !== 'object') {
      window.Application.ribbonUI = ribbonUI
    }
  } catch (e) { /* 忽略 */ }
  dshEnsureEnum()

  // 侧栏通过 BroadcastChannel 请求打开配置悬浮窗。
  // 侧栏（任务窗格）自己调 ShowDialog 不一定成功，交给加载项主上下文更稳。
  // 配置悬浮窗保存后，回一条 config-saved 让侧栏刷新状态。
  try {
    DSH_BUS.on(function (msg) {
      if (!msg) return
      if (msg.type === 'open-settings') dshOpenSettings()
      else if (msg.type === 'config-saved') dshInvalidate('btnToggleChat')
    })
  } catch (e) { /* 忽略 */ }

  setTimeout(function () {
    try { dshBoot() } catch (e) { /* 忽略 */ }
  }, 1200)

  return true
}

function OnAction(control) {
  try {
    if (control.Id === 'btnToggleChat') dshToggleChat()
    else if (control.Id === 'btnOpenSettings') dshOpenSettings()
  } catch (e) {
    alert('操作失败：' + (e && e.message ? e.message : e))
  }
  return true
}

function OnGetLabel(control) {
  if (control.Id === 'btnToggleChat') {
    return dshChatVisible() ? '收起助手' : '打开助手'
  }
  return ''
}

function OnGetVisible(control) { return true }

function GetImage(control) {
  if (control.Id === 'btnOpenSettings') return 'images/2.svg'
  return 'images/1.svg'
}

/* ---------------- 兜底启动 ----------------
   OnAddinLoad 由 ribbon.xml 的 onLoad 触发 —— 一旦 ribbon.xml 被 WPS 拒绝，
   它**永远不会被调用**，而且没有任何报错。所以这里再挂一个不依赖 Ribbon 的启动路径：
   脚本一加载就开始计时，dshBoot 内部有 booted 标志，两条路只会生效一次。 */
setTimeout(function () {
  try { dshBoot() } catch (e) { dshTrace('兜底启动失败: ' + (e && e.message ? e.message : e)) }
}, 2600)
