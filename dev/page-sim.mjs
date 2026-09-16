/**
 * 页面运行时模拟器 —— 在没有浏览器的情况下真正执行页面逻辑。
 *
 * 为什么需要它：
 *   开发环境里没有可用的浏览器（无头 Edge 被沙箱拦），
 *   静态语法检查只能证明"能编译"，证明不了"跑起来不炸"。
 *   这里用一个极简 DOM 模拟器把页面脚本真正跑一遍，
 *   并且把请求打到**真实运行中的本地服务**上 —— 所以这是集成测试，不是纯 mock。
 *
 * 能抓到的：拼错的 API、空引用、初始化流程里的运行时异常、接口字段写错。
 * 抓不到的：CEF 特有的渲染/布局问题（那只能靠真机）。
 *
 * 用法： node dev/page-sim.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADDON = path.resolve(__dirname, '..', 'addon')
// ⚠️ 默认打 43131（专用测试实例）—— 测试会写假 Key，绝不能跑在用户实例上。
const BASE = process.env.DSH_WPS_TEST_URL || 'http://127.0.0.1:43131'

let pass = 0, fail = 0
const ok = (m) => { console.log('  OK    ' + m); pass++ }
const bad = (m) => { console.log('  FAIL  ' + m); fail++ }

/* ---------------- 极简 DOM ---------------- */

class El {
  constructor(tag = 'div', id = '') {
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
    this.className = ''
    this.scrollTop = 0
    this.scrollHeight = 100
    this.dataset = {}
    this.onclick = null
    this._listeners = {}
    const set = new Set()
    this.classList = {
      add: (...c) => c.forEach(x => set.add(x)),
      remove: (...c) => c.forEach(x => set.delete(x)),
      contains: (c) => set.has(c),
      toString: () => [...set].join(' ')
    }
    this.style = { cssText: '', setProperty () {}, removeProperty () {} }
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
  querySelectorAll () { return [] }
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

function makeEnvironment (html, pageName) {
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
      // settings.html 用到这两种选择器
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
  doc.body.parentNode = null

  const errors = []
  const timeouts = []

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
  const winListeners = {}
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
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timeouts.push(t); return t },
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
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseInt, parseFloat, isNaN
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  ctx.self = ctx

  return { ctx, doc, ids, errors, timeouts }
}

/* ---------------- 执行页面 ---------------- */

function collectScripts (html) {
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 把一个元素树里的所有文本拼起来（模拟器的 innerHTML 只记子节点，所以得递归取） */
function textOf (el) {
  if (!el) return ''
  let s = el._text || ''
  if (el.children && el.children.length) s += ' ' + el.children.map(textOf).join(' ')
  return s.trim()
}

async function runPage (relPath, pageName, opts) {
  console.log('')
  console.log('  ── ' + relPath + ' ──')
  const html = fs.readFileSync(path.join(ADDON, relPath), 'utf8')
  const env = makeEnvironment(html, pageName)
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

  if (crashed) { bad(`${relPath} 执行期抛异常 -> ${crashed}`); return }
  ok(`${relPath} 全部脚本执行完毕，未抛异常`)

  await sleep(2500)   // 等异步请求回来

  if (env.errors.length) bad(`${relPath} 触发了 alert/报错: ${env.errors.join(' | ')}`)
  else ok(`${relPath} 没有触发任何 alert`)

  const r = opts.checks({ doc: env.doc, ids: env.ids, ctx, textOf })
  for (const line of r) { line.ok ? ok(line.msg) : bad(line.msg) }

  if (opts.interact) {
    console.log('    · 交互测试')
    const r2 = await opts.interact({ doc: env.doc, ids: env.ids, ctx, sleep, textOf })
    for (const line of r2) { line.ok ? ok('  ' + line.msg) : bad('  ' + line.msg) }
    if (env.errors.length) bad('  交互过程中触发 alert: ' + env.errors.join(' | '))
  }
}

/* ---------------- 主流程 ---------------- */

console.log('')
console.log('  页面运行时模拟（后端：' + BASE + '）')
console.log('  ' + '-'.repeat(60))

try {
  const ping = await (await fetch(BASE + '/api/ping')).json()
  if (!ping.ok) throw new Error('服务未就绪')
} catch (e) {
  console.log('  ✘ 本地服务没在跑，先启动它：node server/index.mjs')
  process.exit(1)
}

// 无条件把测试实例的 Key 置为假 Key。
// 测试实例是专用的（43131），这里必须**无条件覆盖** ——
// 万一指到了用户实例，宁可把 Key 冲掉也不能拿真实 Key 去发请求（那是用户的钱）。
{
  const cfg = await (await fetch(BASE + '/api/config')).json()
  await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: cfg.providerId || 'deepseek',
      baseURL: cfg.baseURL || 'https://api.deepseek.com/v1',
      model: cfg.model || 'deepseek-chat',
      apiKey: 'fixture-pagesim-not-a-credential'
    })
  })
  console.log('  （已把测试实例的 Key 置为假 Key）')
}

await runPage('ui/settings.html', 'settings.html', {
  checks: ({ ids }) => {
    const out = []
    const sel = ids.get('provider')
    out.push({ ok: sel && sel.children.length === 9, msg: `厂商下拉被填充了 ${sel ? sel.children.length : 0} 项（期望 9）` })
    const burl = ids.get('baseURL')
    out.push({ ok: burl && /^https?:\/\//.test(burl.value), msg: `baseURL 自动填充 = ${burl ? JSON.stringify(burl.value) : 'null'}` })
    const model = ids.get('model')
    out.push({ ok: model && model.value.length > 0, msg: `模型名自动填充 = ${model ? JSON.stringify(model.value) : 'null'}` })
    const dl = ids.get('modelList')
    out.push({ ok: dl && dl.children.length > 0, msg: `模型候选 datalist 有 ${dl ? dl.children.length : 0} 项` })
    const st = ids.get('status')
    out.push({ ok: st && st.textContent.length > 0, msg: `状态栏文案 = ${st ? JSON.stringify(st.textContent) : 'null'}` })
    const note = ids.get('keyNote')
    out.push({ ok: note && note.textContent.length > 0, msg: `Key 提示文案 = ${note ? JSON.stringify(note.textContent.slice(0, 30)) : 'null'}` })
    return out
  },
  interact: async ({ ids, sleep, textOf }) => {
    const out = []
    // 测试连接：配置里是个假 Key，应该走到"人话错误"分支而不是崩掉
    ids.get('btnTest').onclick()
    await sleep(3000)
    const res = ids.get('result')
    out.push({ ok: String(res.className).indexOf('show') >= 0, msg: `点「测试连接」后结果区可见（class=${res.className}）` })
    out.push({ ok: textOf(res).length > 0, msg: `结果区文案 = ${JSON.stringify(textOf(res).slice(0, 70))}` })
    out.push({ ok: ids.get('btnTest').disabled === false, msg: '测试按钮已恢复可用（没有卡在 loading）' })
    // 保存
    ids.get('btnSave').onclick()
    await sleep(2000)
    out.push({ ok: textOf(ids.get('status')).length > 0, msg: `保存后状态栏 = ${JSON.stringify(textOf(ids.get('status')))}` })
    return out
  }
})

await runPage('ui/chat.html', 'chat.html', {
  checks: ({ ids }) => {
    const out = []
    const dot = ids.get('dot')
    out.push({ ok: dot && dot.className.indexOf('ok') >= 0, msg: `服务状态点 = ${dot ? JSON.stringify(dot.className) : 'null'}（应为 ok）` })
    const mi = ids.get('modelInfo')
    out.push({ ok: mi && mi.textContent.length > 0, msg: `模型信息栏 = ${mi ? JSON.stringify(mi.textContent) : 'null'}` })
    const hint = ids.get('hint')
    out.push({ ok: hint && hint.textContent.length > 0, msg: `底部提示 = ${hint ? JSON.stringify(hint.textContent) : 'null'}` })
    return out
  },
  interact: async ({ ids, sleep, textOf }) => {
    const out = []
    ids.get('useSelection').checked = false
    ids.get('input').value = '你好，测一下'
    ids.get('btnSend').onclick()
    await sleep(4000)
    const msgs = ids.get('messages')
    out.push({ ok: msgs.children.length > 0, msg: `发送后消息区出现 ${msgs.children.length} 个节点` })
    out.push({ ok: ids.get('input').value === '', msg: '输入框已清空' })
    out.push({ ok: ids.get('btnSend').textContent === '发送', msg: `发送按钮已恢复（当前文案 = ${JSON.stringify(ids.get('btnSend').textContent)}）` })
    const banner = ids.get('banner')
    const bTxt = textOf(banner)
    const bHidden = String(banner.className).indexOf('hidden') >= 0
    out.push({ ok: bHidden || bTxt.length > 0, msg: `失败横幅 = ${bHidden ? '隐藏（请求成功）' : JSON.stringify(bTxt.slice(0, 80))}` })
    return out
  }
})

console.log('')
console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
process.exit(fail > 0 ? 1 : 0)
