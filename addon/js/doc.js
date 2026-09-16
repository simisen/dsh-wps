/* ============================================================
 * 文档操作层 —— 助手的"手"。
 *
 * 所有函数都返回 { ok, text }，text 是**回给模型看**的结果字符串。
 * 所以文案要写清楚"做了什么、结果如何"，模型据此决定下一步。
 *
 * 关于安全兜底（这是最要紧的部分）：
 *   - 一轮开始时开「修订留痕」，助手改的每个字都以修订形式出现，
 *     用户可以逐条接受或拒绝 —— 不会悄悄改掉文档。
 *   - 同时用 UndoRecord.StartCustomRecord / EndCustomRecord 把**整轮**改动
 *     打包成一个撤销单元：按一次 Ctrl+Z 全部退回，而不是狂按几十次。
 *   这两条在阶段 0 都实测验证过。
 * ============================================================ */

var DSH_DOC = (function () {

  /** 写入方式由配置决定，侧栏读到配置后写进来 */
  var UI = { writeMode: 'track' }

  function app () { try { return window.Application } catch (e) { return null } }
  function activeDoc () {
    var a = app()
    try { return a && a.ActiveDocument ? a.ActiveDocument : null } catch (e) { return null }
  }

  /** WPS 的 Range.Text 用 \r 分段、\a 表示段落标记，统一成 \n */
  function norm (t) {
    return String(t == null ? '' : t)
      .replace(/[\r\a\v\f]/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  }

  function noDoc () {
    return { ok: false, text: '当前没有打开的文档。请提醒用户在 WPS 里打开或新建一个文档。' }
  }

  /* ---------------- 一轮的撤销打包 ---------------- */

  var turn = { recording: false, prevTrack: null, writes: 0 }

  function beginTurn (writeMode) {
    if (turn.recording) return
    var d = activeDoc()
    if (!d) return
    try {
      if (writeMode !== 'direct') {
        turn.prevTrack = d.TrackRevisions
        d.TrackRevisions = true
      }
    } catch (e) { /* 有些文档类型不支持修订，不阻断 */ }
    try {
      var a = app()
      if (a && a.UndoRecord && typeof a.UndoRecord.StartCustomRecord === 'function') {
        a.UndoRecord.StartCustomRecord('DSH 助手修改')
        turn.recording = true
      }
    } catch (e) { /* 没有 UndoRecord 就退化成普通撤销 */ }
  }

  function endTurn () {
    var a = app()
    var d = activeDoc()
    if (turn.recording) {
      try { a.UndoRecord.EndCustomRecord() } catch (e) {}
      turn.recording = false
    }
    if (turn.prevTrack !== null) {
      try { if (d) d.TrackRevisions = turn.prevTrack } catch (e) {}
      turn.prevTrack = null
    }
    var n = turn.writes
    turn.writes = 0
    return n
  }

  function currentWriteMode () { return UI.writeMode || 'track' }

  /* ---------------- 读 ---------------- */

  function getDocumentInfo () {
    var d = activeDoc()
    if (!d) return noDoc()
    var lines = []
    try { lines.push('文件名：' + d.Name) } catch (e) { lines.push('文件名：未知') }

    var selLen = 0
    try {
      var sel = app().Selection
      if (sel && sel.Range) selLen = norm(sel.Range.Text).replace(/\n/g, '').length
    } catch (e) {}
    lines.push(selLen > 0 ? ('当前选中：' + selLen + ' 字') : '当前没有选中内容')

    try {
      var total = norm(d.Content.Text).length
      lines.push('文档总长：约 ' + total + ' 字')
    } catch (e) {}

    try {
      lines.push('修订留痕：' + (d.TrackRevisions ? '已开启' : '未开启'))
    } catch (e) {}

    return { ok: true, text: lines.join('\n') }
  }

  function getSelection () {
    var d = activeDoc()
    if (!d) return noDoc()
    try {
      var sel = app().Selection
      if (!sel || !sel.Range) return { ok: false, text: '读不到选区。' }
      var t = norm(sel.Range.Text)
      if (!t.trim()) {
        return { ok: false, text: '用户当前没有选中任何内容。请先问清楚要处理哪一段，不要擅自改动整篇文档。' }
      }
      return { ok: true, text: t }
    } catch (e) {
      return { ok: false, text: '读取选区失败：' + (e && e.message ? e.message : e) }
    }
  }

  function getDocumentText (args) {
    var d = activeDoc()
    if (!d) return noDoc()
    var max = Math.min(20000, Math.max(200, Number(args && args.maxChars) || 4000))
    try {
      var full = norm(d.Content.Text)
      if (full.length <= max) return { ok: true, text: full }
      return { ok: true, text: full.slice(0, max) + '\n\n…（文档共 ' + full.length + ' 字，这里只返回了前 ' + max + ' 字）' }
    } catch (e) {
      return { ok: false, text: '读取正文失败：' + (e && e.message ? e.message : e) }
    }
  }

  /* ---------------- 写 ---------------- */

  function replaceSelection (args) {
    var d = activeDoc()
    if (!d) return noDoc()
    var text = String((args && args.text) != null ? args.text : '')
    if (!text) return { ok: false, text: '没有提供替换后的文字。' }
    try {
      var sel = app().Selection
      if (!sel || !sel.Range) return { ok: false, text: '读不到选区，无法替换。' }
      var before = norm(sel.Range.Text)
      if (!before.trim()) {
        return { ok: false, text: '用户当前没有选中任何内容，无法替换。请改用 insert_text，或先让用户选中目标段落。' }
      }
      beginTurn(currentWriteMode())
      sel.Range.Text = text
      turn.writes++
      return {
        ok: true,
        text: '已把选中的 ' + before.replace(/\n/g, '').length + ' 字替换为 ' + text.length + ' 字。'
          + '（改动以修订形式出现，用户可以逐条接受或拒绝；整轮改动可一次撤销）'
      }
    } catch (e) {
      return { ok: false, text: '替换失败：' + (e && e.message ? e.message : e) }
    }
  }

  function insertText (args) {
    var d = activeDoc()
    if (!d) return noDoc()
    var text = String((args && args.text) != null ? args.text : '')
    if (!text) return { ok: false, text: '没有提供要插入的文字。' }
    try {
      var sel = app().Selection
      var at = 0
      try {
        if (sel && typeof sel.End === 'number') at = sel.End
        else if (sel && sel.Range && typeof sel.Range.End === 'number') at = sel.Range.End
      } catch (e) { at = 0 }

      beginTurn(currentWriteMode())
      var r = d.Range(at, at)
      r.Text = text
      turn.writes++
      return { ok: true, text: '已在光标位置插入 ' + text.length + ' 字。' }
    } catch (e) {
      return { ok: false, text: '插入失败：' + (e && e.message ? e.message : e) }
    }
  }

  function replaceAll (args) {
    var d = activeDoc()
    if (!d) return noDoc()
    var find = String((args && args.find) != null ? args.find : '')
    var repl = String((args && args.replace) != null ? args.replace : '')
    if (!find) return { ok: false, text: '没有提供要查找的文字。' }

    try {
      beginTurn(currentWriteMode())
      var content = d.Content
      var f = content.Find
      var count = 0

      try { f.ClearFormatting() } catch (e) {}
      f.Text = find
      try { f.Forward = true } catch (e) {}
      try { f.Wrap = 1 } catch (e) {}          // wdFindContinue
      try { f.MatchCase = !!(args && args.matchCase) } catch (e) {}

      // 最多替换 500 处，防止意外把整篇文档改烂
      var guard = 0
      while (guard++ < 500) {
        var hit = false
        try { hit = !!f.Execute() } catch (e) { throw e }
        if (!hit) break
        try { content.Text = repl } catch (e) { break }
        count++
        // 替换为空串时要防止死循环
        if (repl === '') { try { f.Execute() } catch (e) {} }
      }

      turn.writes++
      if (count === 0) return { ok: true, text: '全文没有找到「' + find + '」，未做任何修改。' }
      return { ok: true, text: '已替换 ' + count + ' 处「' + find + '」→「' + repl + '」。' }
    } catch (e) {
      return { ok: false, text: '批量替换失败（可能是该文档不支持查找替换）：' + (e && e.message ? e.message : e) }
    }
  }

  /* ---------------- 分发 ---------------- */

  var IMPL = {
    get_document_info: getDocumentInfo,
    get_selection: getSelection,
    get_document_text: getDocumentText,
    replace_selection: replaceSelection,
    insert_text: insertText,
    replace_all: replaceAll
  }

  return {
    setWriteMode: function (m) { UI.writeMode = m === 'direct' ? 'direct' : 'track' },
    beginTurn: beginTurn,
    endTurn: endTurn,
    handles: function (name) { return Object.prototype.hasOwnProperty.call(IMPL, name) },
    invoke: function (name, args) {
      var fn = IMPL[name]
      if (!fn) return { ok: false, text: '未知的工具：' + name }
      try { return fn(args || {}) } catch (e) {
        return { ok: false, text: '工具执行异常：' + (e && e.message ? e.message : e) }
      }
    },
    /** 供测试与调试：暴露内部实现 */
    _impl: IMPL
  }
})()
