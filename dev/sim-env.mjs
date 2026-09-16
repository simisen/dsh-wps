/**
 * 共享的模拟环境：极简 DOM + 模拟的 WPS Application。
 *
 * 用途：在没有浏览器、没有 WPS 的情况下**真正执行**加载项页面脚本，
 * 并且让文档操作打到一个可断言的假文档上。
 *
 * 抽成模块是为了让工具链测试（tool-loop-test）用上完整的假文档模型，
 * 同时给后续需要"可断言的假 WPS"的测试留一个共同底座。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ADDON = path.resolve(__dirname, '..', 'addon')
/**
 * ⚠️ 测试默认打 **43131**（专用测试实例），不是 43130（用户的实例）。
 *
 * 为什么必须分开：测试会写假 Key、还会真的发出模型请求。
 * 跑在用户实例上会**覆盖掉用户填的真实 API Key**，并且花用户的钱。
 * 这是踩过的坑。跑测试前先起一个独立实例：
 *     set DSH_WPS_HOME=dev\testhome-isolated
 *     set DSH_WPS_PORT=43131
 *     node server\index.mjs
 */
export const BASE = process.env.DSH_WPS_TEST_URL || 'http://127.0.0.1:43131'

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/* ---------------- 极简 DOM ---------------- */

export class El {
  constructor (tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase()
    this.id = id
    this.children = []
    this.parentNode = null
    this._text = ''
    this._html = ''
    this.value = ''
    this.checked = false
    this.disabled = false
    this.placeholder = ''
    this.type = ''
    this.scrollTop = 0
    this.scrollHeight = 100
    this.dataset = {}
    this.onclick = null
    this._listeners = {}
    // className 和 classList 必须指向同一份状态 ——
    // 之前它们是两份独立数据，导致 classList.add('hidden') 之后
    // 断言 className 仍然看不到 hidden，测试结果不可信。
    this._classes = new Set()
    const self = this
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toString: () => [...self._classes].join(' ')
    }
    this.style = { cssText: '', setProperty () {}, removeProperty () {} }
  }
  get className () { return [...this._classes].join(' ') }
  set className (v) {
    this._classes = new Set(String(v == null ? '' : v).split(/\s+/).filter(Boolean))
  }
  get textContent () { return this._text }
  set textContent (v) { this._text = String(v); this.children = [] }
  get innerHTML () { return this._html }
  set innerHTML (v) { this._html = String(v); this.children = [] }
  get firstChild () { return this.children[0] || null }
  appendChild (c) { if (c) { c.parentNode = this; this.children.push(c) } return c }
  removeChild (c) { this.children = this.children.filter(x => x !== c); return c }
  remove () { if (this.parentNode) this.parentNode.removeChild(this) }
  insertBefore (c) { return this.appendChild(c) }
  querySelector () { return null }
  querySelectorAll (sel) {
    // 真实 DOM 会做子树查询；renderAll() 靠它清掉旧节点。
    // 之前返回空数组，导致消息节点只增不减，测试看到的列表是错的。
    const cls = String(sel).replace(/^\./, '')
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        if (c._classes && c._classes.has(cls)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  closest (sel) {
    let n = this
    const cls = String(sel).replace(/^\./, '')
    const tag = cls.toUpperCase()
    while (n) {
      if (n.tagName === tag) return n
      if (n.className && String(n.className).split(/\s+/).indexOf(cls) >= 0) return n
      if (n.classList && n.classList.contains(cls)) return n
      n = n.parentNode
    }
    return null
  }
  addEventListener (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f) }
  removeEventListener () {}
  dispatchEvent (ev) { (this._listeners[ev && ev.type] || []).forEach(f => f(ev)); return true }
  select () {}
  focus () {}
  blur () {}
  click () { if (this.onclick) this.onclick({ preventDefault () {} }) }
}

export function textOf (el) {
  if (!el) return ''
  // 流式文本是通过 innerHTML 写进去的，取文本时不能漏掉它
  let s = el._text || ''
  if (el._html) s += ' ' + String(el._html).replace(/<[^>]*>/g, '')
  if (el.children && el.children.length) s += ' ' + el.children.map(textOf).join(' ')
  return s.replace(/\s+/g, ' ').trim()
}

/* ---------------- 模拟的 WPS Application ---------------- */

export function makeFakeWord (opts = {}) {
  const state = {
    text: opts.text != null ? String(opts.text) : '这是一段原始的示例文字。',
    docName: opts.docName || '测试文档.docx',
    trackRevisions: false,
    trackToggleCount: 0,
    writes: [],
    undo: { starts: 0, ends: 0, recording: false, lastName: '' },
    calls: []
  }

  const sel = opts.selection || null
  let selStart = 0
  let selEnd = 0
  if (sel) {
    const i = state.text.indexOf(sel)
    if (i >= 0) { selStart = i; selEnd = i + sel.length }
  } else {
    selStart = selEnd = state.text.length
  }

  function rangeAt (s, e, kind) {
    let start = s
    let end = e
    return {
      get Start () { return start },
      get End () { return end },
      get Text () { return state.text.slice(start, end) },
      set Text (v) {
        const value = String(v == null ? '' : v)
        const removed = state.text.slice(start, end)
        state.text = state.text.slice(0, start) + value + state.text.slice(end)
        state.writes.push({ kind, from: removed, to: value, at: start })
        state.calls.push({ op: kind, from: removed, to: value })
        end = start + value.length
        if (kind === 'replace_selection') { selStart = start; selEnd = end }
      },
      Select () {},
      Find: null
    }
  }

  const doc = {
    Name: state.docName,
    get Content () { return rangeAt(0, state.text.length, 'content') },
    get TrackRevisions () { return state.trackRevisions },
    set TrackRevisions (v) {
      state.trackRevisions = !!v
      state.trackToggleCount++
      state.calls.push({ op: 'set_track_revisions', value: !!v })
    },
    Range (a, b) { return rangeAt(a == null ? 0 : a, b == null ? 0 : b, 'range') },
    get Revisions () {
      return {
        get Count () { return state.writes.filter(w => w.kind === 'replace_selection').length },
        Item: () => null
      }
    }
  }

  const pluginStore = {}
  const app = {
    ActiveDocument: doc,
    Selection: {
      get Range () { return rangeAt(selStart, selEnd, 'replace_selection') },
      get Start () { return selStart },
      get End () { return selEnd }
    },
    UndoRecord: {
      StartCustomRecord (name) {
        state.undo.starts++
        state.undo.recording = true
        state.undo.lastName = String(name || '')
        state.calls.push({ op: 'undo_start', name: state.undo.lastName })
      },
      EndCustomRecord () {
        state.undo.ends++
        state.undo.recording = false
        state.calls.push({ op: 'undo_end' })
      },
      CustomRecordName: '',
      IsRecordingCustomRecord: false,
      CustomRecordLevel: 0
    },
    PluginStorage: {
      getItem (k) { return Object.prototype.hasOwnProperty.call(pluginStore, k) ? pluginStore[k] : null },
      setItem (k, v) { pluginStore[k] = v }
    },
    Enum: { msoCTPDockPositionLeft: 0, msoCTPDockPositionRight: 2 },
    Documents: { Add () { return doc } },
    CreateTaskPane (url) { state.calls.push({ op: 'create_task_pane', url }); return { ID: 1, Visible: false, DockPosition: 0 } },
    GetTaskPane () { return { ID: 1, Visible: true, DockPosition: 0 } },
    ShowDialog (url) { state.calls.push({ op: 'show_dialog', url }); return true },
    ribbonUI: { InvalidateControl () {}, Invalidate () {} }
  }

  return {
    app,
    state,
    get text () { return state.text },
    get selection () { return state.text.slice(selStart, selEnd) },
    setSelection (s, e) { selStart = s; selEnd = e },
    calls: state.calls
  }
}

/* ---------------- 环境装配 ---------------- */

export function makeEnvironment (html, pageName, extra = {}) {
  const ids = new Map()
  let m
  const idRe = /\bid\s*=\s*"([^"]+)"/g
  while ((m = idRe.exec(html)) !== null) ids.set(m[1], new El('div', m[1]))

  const doc = {
    readyState: 'complete',
    getElementById: (id) => ids.get(id) || null,
    createElement: (tag) => new El(tag),
    createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (sel) => {
      const mm = /^input\[name=(\w+)\]\[value=(\w+)\]$/.exec(sel.trim())
      if (mm) { const e = new El('input'); e.name = mm[1]; e.value = mm[2]; e.checked = false; return e }
      const mc = /^input\[name=(\w+)\]:checked$/.exec(sel.trim())
      if (mc) { const e = new El('input'); e.name = mc[1]; e.value = 'track'; e.checked = true; return e }
      return null
    },
    querySelectorAll: () => [],
    body: new El('body'),
    title: pageName
  }

  const errors = []
  const winListeners = {}

  class XHR {
    constructor () { this.readyState = 0; this.status = 0; this.responseText = ''; this._h = {} }
    open (m, u) { this._m = m; this._u = new URL(u, BASE).href; this.readyState = 1 }
    setRequestHeader (k, v) { this._h[k] = v }
    getAllResponseHeaders () { return '' }
    send (body) {
      fetch(this._u, { method: this._m, headers: this._h, body })
        .then(async (r) => {
          this.status = r.status
          this.responseText = await r.text()
          this.readyState = 4
          if (this.onreadystatechange) this.onreadystatechange()
        })
        .catch((e) => { this.readyState = 4; if (this.onerror) this.onerror(e) })
    }
  }

  const bus = { handlers: [] }
  class FakeBroadcastChannel {
    constructor (name) { this.name = name }
    postMessage (msg) { bus.handlers.forEach(h => { try { h({ data: msg }) } catch (e) {} }) }
    set onmessage (fn) { bus.handlers.push(fn) }
    close () {}
  }

  const ctx = {
    console,
    document: doc,
    location: { origin: BASE, href: BASE + '/ui/' + pageName, toString () { return BASE + '/ui/' + pageName } },
    navigator: { userAgent: 'dsh-page-sim', clipboard: { writeText: () => Promise.resolve() } },
    fetch: (u, o) => fetch(new URL(u, BASE).href, o),
    XMLHttpRequest: XHR,
    BroadcastChannel: FakeBroadcastChannel,
    AbortController,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    alert: (msg) => errors.push('alert(): ' + msg),
    addEventListener: (t, f) => { winListeners[t] = (winListeners[t] || []).concat(f) },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    open: () => null,
    close: () => {},
    Image: class { set src (v) { this._src = v } get src () { return this._src } },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Map, Set,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseInt, parseFloat, isNaN,
    ...extra
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  ctx.self = ctx

  return { ctx, doc, ids, errors, bus }
}

/* ---------------- 执行页面 ---------------- */

export function collectScripts (html) {
  const out = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || ''
    const srcMatch = /\bsrc\s*=\s*"([^"]+)"/.exec(attrs)
    if (srcMatch) {
      const rel = srcMatch[1].replace(/^\//, '')
      const full = path.join(ADDON, rel)
      if (fs.existsSync(full)) out.push({ name: srcMatch[1], code: fs.readFileSync(full, 'utf8') })
    } else if (m[2].trim()) {
      out.push({ name: '(inline)', code: m[2] })
    }
  }
  return out
}

/** 把页面真正跑起来。返回 { env, ctx, crashed } */
export function runPageSync (relPath, pageName, extra = {}) {
  const html = fs.readFileSync(path.join(ADDON, relPath), 'utf8')
  const env = makeEnvironment(html, pageName, extra)
  const ctx = vm.createContext(env.ctx)
  let crashed = null
  for (const s of collectScripts(html)) {
    try {
      vm.runInContext(s.code, ctx, { filename: relPath + ':' + s.name })
    } catch (e) {
      crashed = `${s.name}: ${e.message}`
      break
    }
  }
  return { env, ctx, crashed }
}
