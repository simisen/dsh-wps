/**
 * DSH-WPS 本地服务。
 *
 * 它同时是两样东西：
 *   1. WPS 加载项的**静态托管**（加载项页面就是从这儿加载的 → 同源，不需要 CORS，也不需要端口发现）
 *   2. agent 后端（配置读写、测试连接、对话转发）
 *
 * 零第三方依赖：只用 Node 内置模块 + 全局 fetch。
 *
 * 为什么请求要由本地服务发，而不是加载项页面直接发：
 *   - 页面直连厂商 API 会撞 CORS（各家政策不同），还可能被 WPS 的 CEF 网络栈干扰
 *   - Key 会落在浏览器上下文里
 *   走本地服务则两个问题都不存在。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { providersForClient, getProvider } from './providers.mjs'
import {
  publicConfig, writeConfig, setApiKey, getApiKey,
  readConfig, HOME_DIR, configPath, credPath
} from './store.mjs'
import { testConnection, listModels } from './llm.mjs'
import { createInProcRuntime } from './agent/loop.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADDON_DIR = path.resolve(__dirname, '..', 'addon')

const HOST = process.env.DSH_WPS_HOST || '127.0.0.1'
const PORT = Number(process.env.DSH_WPS_PORT || 43130)
const VERSION = '0.1.0'
const VERBOSE = process.argv.includes('--verbose')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

// 可选的文件日志。设了 DSH_WPS_LOG 就同时写到文件 ——
// 服务常常是被隐藏窗口拉起来的，控制台看不到，出问题只能靠日志文件。
const LOG_FILE = process.env.DSH_WPS_LOG || ''
if (LOG_FILE) {
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }) } catch { /* 建不了就算了 */ }
}

function fmt(args) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  return `[${t}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}
function writeLogFile(line) {
  if (!LOG_FILE) return
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch { /* 日志写不进去不能影响主流程 */ }
}

/** 重要事件：控制台和文件都写 */
function log(...args) {
  const line = fmt(args)
  console.log(line)
  writeLogFile(line)
}

/** 细节事件（请求级）：**文件一定写**，控制台只在 --verbose 时打。
    服务常常是被隐藏窗口拉起来的，根本没有控制台可看 ——
    所以"要不要记进文件"不能取决于有没有加 --verbose。 */
function flog(...args) {
  const line = fmt(args)
  if (VERBOSE) console.log(line)
  writeLogFile(line)
}

const vlog = flog

/* ---------------- 工具 ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/* ---------------- API ---------------- */

async function apiPing(req, res) {
  sendJson(res, 200, {
    ok: true,
    app: 'dsh-wps',
    version: VERSION,
    time: new Date().toISOString(),
    home: HOME_DIR
  })
}

async function apiProviders(req, res) {
  sendJson(res, 200, { providers: providersForClient() })
}

async function apiGetConfig(req, res) {
  sendJson(res, 200, publicConfig())
}

async function apiPostConfig(req, res) {
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { ok: false, short: '请求格式不对' })
  }

  const provider = getProvider(payload.providerId)
  if (!provider) return sendJson(res, 400, { ok: false, short: '未知的厂商' })

  // Key 的语义必须区分「没填」和「要清除」：
  //   没填 / 空串  → 保持原样（界面上写的就是"留空 = 不修改"）
  //   clearKey     → 显式清除
  //   非空字符串   → 覆盖
  // 之前这里是 `if (payload.apiKey !== undefined) setApiKey(...)`，
  // 结果界面说"留空不修改"、实际却把 Key 删了 —— 交互测试抓出来的。
  if (payload.clearKey === true) {
    setApiKey(provider.id, '')
  } else if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
    setApiKey(provider.id, payload.apiKey.trim())
  }

  const cfg = writeConfig({
    providerId: provider.id,
    api: provider.api,
    baseURL: (payload.baseURL || provider.baseURL || '').trim(),
    model: (payload.model || '').trim(),
    writeMode: payload.writeMode,
    undoGrouping: payload.undoGrouping,
    temperature: payload.temperature,
    maxTokens: payload.maxTokens
  })

  log(`配置已更新：${provider.name} / ${cfg.model || '(未填模型)'} / Key=${getApiKey(provider.id).key ? '已设置' : '未设置'}`)
  sendJson(res, 200, { ok: true, config: publicConfig() })
}

async function apiTest(req, res) {
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { ok: false, short: '请求格式不对' })
  }

  const provider = getProvider(payload.providerId)
  if (!provider) return sendJson(res, 400, { ok: false, short: '未知的厂商' })

  // 允许"先测再存"：请求里带的 Key 优先，其次读已存的
  const keyFromReq = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  const key = keyFromReq || getApiKey(provider.id).key

  if (!key && provider.needsKey !== false) {
    return sendJson(res, 200, {
      ok: false, short: '还没填 API Key', hint: '把厂商给的 Key 粘贴进来再测。'
    })
  }

  const probeModel = (payload.model || readConfig().model || '').trim()
  log(`测试连接：${provider.name} / ${probeModel || '(未填模型)'} ...`)
  const result = await testConnection({
    api: provider.api,
    baseURL: (payload.baseURL || provider.baseURL || '').trim(),
    apiKey: key,
    model: probeModel,
    providerName: provider.name
  })
  log(`测试结果：${result.ok ? '成功' : '失败'} — ${result.short} (${result.latencyMs}ms)`)
  sendJson(res, 200, result)
}

/** 向厂商要一份真实可用的模型列表 */
async function apiModels (req, res) {
  let payload = {}
  try { payload = JSON.parse(await readBody(req)) } catch { /* 允许空 body，那就用当前配置 */ }

  const provider = getProvider(payload.providerId) || getProvider(readConfig().providerId)
  if (!provider) return sendJson(res, 400, { ok: false, short: '未知的厂商', models: [] })

  const keyFromReq = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  const key = keyFromReq || getApiKey(provider.id).key
  const baseURL = (payload.baseURL || provider.baseURL || '').trim()

  log(`拉取模型列表：${provider.name} …`)
  const out = await listModels({ api: provider.api, baseURL, apiKey: key })
  log(`拉取结果：${out.ok ? out.count + ' 个模型' : out.short}`)
  sendJson(res, 200, out)
}

/* ---------------- 对话：agent 循环 + 文档工具 ----------------
 *
 * 为什么工具结果要绕一圈回来：
 *   文档操作只能在 WPS 加载项上下文里执行（只有它持有 window.Application），
 *   而 agent 循环跑在这里。所以流程是：
 *     服务 →（SSE 事件 tool）→ 侧栏执行 JSAPI →（POST /api/tool-result）→ 服务继续
 *   这条"反向调用"是让助手真的能改文档的关键。
 */

/** 进行中的轮次：turnId -> { pending: Map<toolCallId, resolve> } */
const TURNS = new Map()
const TOOL_TIMEOUT_MS = 30000

function newTurnId () {
  return 'turn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

async function apiChat (req, res) {
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { ok: false, short: '请求格式不对' })
  }

  const cfg = readConfig()
  const provider = getProvider(cfg.providerId)
  if (!provider) return sendJson(res, 400, { ok: false, short: '配置里的厂商不存在，请重新设置' })

  const keyInfo = getApiKey(provider.id)
  if (!keyInfo.key && provider.needsKey !== false) {
    return sendJson(res, 400, { ok: false, short: '还没配置 API Key', hint: '点右上角「⚙ 设置」填一下。' })
  }
  if (!cfg.model) {
    return sendJson(res, 400, { ok: false, short: '还没选模型', hint: '点右上角「⚙ 设置」。' })
  }

  const userText = String(payload.text || '').trim()
  if (!userText) return sendJson(res, 400, { ok: false, short: '没有消息内容' })

  const history = Array.isArray(payload.messages) ? payload.messages : []
  const docContext = String(payload.docContext || '')

  const turnId = newTurnId()
  const pending = new Map()
  TURNS.set(turnId, { pending })

  let closed = false
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const sse = obj => { if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n') }

  // 侧栏要先知道 turnId，才能把工具结果带回来
  sse({ type: 'turn', turnId })

  req.on('close', () => {
    closed = true
    // 把没回来的工具请求全部放掉，否则 agent 循环会永远挂在这里
    for (const [, resolve] of pending) resolve({ ok: false, text: '侧栏已断开' })
    pending.clear()
    TURNS.delete(turnId)
  })

  const executeTool = ({ id, name, args }) => new Promise(resolve => {
    if (closed) { resolve({ ok: false, text: '侧栏已断开' }); return }
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, text: '侧栏执行超时，操作未完成' })
    }, TOOL_TIMEOUT_MS)
    pending.set(id, result => { clearTimeout(timer); resolve(result) })
  })

  const started = Date.now()
  let summary = ''
  try {
    const runtime = createInProcRuntime()
    const out = await runtime.run({
      llm: {
        api: provider.api,
        baseURL: cfg.baseURL,
        apiKey: keyInfo.key,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature
      },
      history,
      userText,
      docContext,
      onEvent: evt => sse(evt),
      executeTool
    })
    const names = (out.toolCalls || []).map(c => c.name).join(',')
    summary = `${out.steps} 步${names ? '，工具[' + names + ']' : ''}`
    sse({ type: 'end', ms: Date.now() - started, steps: out.steps, text: out.text })
  } catch (e) {
    sse({ type: 'error', short: '服务内部错误', hint: String((e && e.message) || e) })
  } finally {
    TURNS.delete(turnId)
    if (!closed) res.end()
    log(`对话结束：${summary || '异常'} 用时 ${Date.now() - started}ms`)
  }
}

/** 侧栏把工具执行结果送回来 */
async function apiToolResult (req, res) {
  let p
  try {
    p = JSON.parse(await readBody(req))
  } catch {
    return sendJson(res, 400, { ok: false, short: '请求格式不对' })
  }
  const turn = TURNS.get(p.turnId)
  const resolve = turn && turn.pending.get(p.id)
  if (resolve) {
    turn.pending.delete(p.id)
    resolve({ ok: !!p.ok, text: p.text == null ? '' : String(p.text) })
  }
  vlog(`工具结果 [${p.name || p.id}] ok=${!!p.ok} matched=${!!resolve}`)
  sendJson(res, 200, { ok: true, matched: !!resolve })
}

/* 客户端错误上报。
   WPS 里没法打开 DevTools，前端出了错只能靠这条通道回传，
   否则用户只会看到"点了没反应"。 */
async function apiClientLog(req, res) {
  try {
    const p = JSON.parse(await readBody(req))
    const where = p.where || '?'
    const msg = String(p.message || '').slice(0, 300)
    // 追踪打点不是错误，得分开显示。
    // 否则日志里一片"前端报错"，真正出错的时候反而被淹没了。
    const isTrace = msg.indexOf('[trace]') === 0
    let line = (isTrace ? '追踪' : '前端报错') + ` [${where}] ${msg}`
    if (p.line) line += ` @${p.line}:${p.col || 0}`
    if (p.src) line += ` <${String(p.src).slice(-60)}>`
    log(line)
    if (p.stack) {
      String(p.stack).split('\n').slice(1, 4).forEach(s => log('    ' + s.trim().slice(0, 160)))
    }
  } catch { /* 上报内容坏了就忽略，绝不能因此 500 */ }
  sendJson(res, 200, { ok: true })
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath)
  if (rel === '/' || rel === '') rel = '/index.html'
  // 标出请求是不是来自 WPS 内嵌浏览器 —— 日志里一眼能分清
  // "加载项真的在 WPS 里跑了" 和 "有人用 curl/测试脚本访问了"。
  const ua = String(req.headers['user-agent'] || '')
  const uaTag = /WpsOfficeApp/i.test(ua) ? ' [WPS]' : (/node|curl|python/i.test(ua) ? ' [非WPS]' : '')
  const full = path.normalize(path.join(ADDON_DIR, rel))
  if (!full.startsWith(path.normalize(ADDON_DIR))) {
    res.writeHead(403); res.end('forbidden'); return
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      vlog('静态 404:' + uaTag, rel)
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 ' + rel)
      return
    }
    vlog('静态 200:' + uaTag, rel, data.length + 'B')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      // 开发期不缓存，改了立刻生效
      'Cache-Control': 'no-store'
    })
    res.end(data)
  })
}

/* ---------------- 路由 ---------------- */

const ROUTES = {
  'GET /api/ping': apiPing,
  'GET /api/providers': apiProviders,
  'GET /api/config': apiGetConfig,
  'POST /api/config': apiPostConfig,
  'POST /api/test': apiTest,
  'POST /api/models': apiModels,
  'POST /api/chat': apiChat,
  'POST /api/tool-result': apiToolResult,
  'POST /api/clientlog': apiClientLog
}

const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try {
    pathname = new URL(req.url, 'http://' + HOST).pathname
  } catch { /* 忽略畸形 URL */ }

  const key = req.method + ' ' + pathname
  const handler = ROUTES[key]
  if (handler) {
    try {
      await handler(req, res)
    } catch (e) {
      log('API 处理出错:', pathname, e && e.message)
      if (!res.headersSent) sendJson(res, 500, { ok: false, short: '服务内部错误', hint: String(e && e.message || e) })
      else try { res.end() } catch {}
    }
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname)
    return
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('405')
})

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('')
    console.error(`  端口 ${PORT} 已被占用。`)
    console.error(`  可能是本服务已经在运行（那就直接用，不用再开一个），`)
    console.error(`  或者换个端口：  set DSH_WPS_PORT=43131  &&  node server\\index.mjs`)
    console.error('')
    process.exit(1)
  }
  console.error('服务启动失败：', e)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const cfg = readConfig()
  const provider = getProvider(cfg.providerId)
  console.log('')
  console.log('  DSH × WPS 本地服务已启动')
  console.log('  ────────────────────────────────────────────')
  console.log(`  地址      http://${HOST}:${PORT}`)
  console.log(`  加载项    ${ADDON_DIR}`)
  console.log(`  配置目录  ${HOME_DIR}`)
  console.log(`  当前模型  ${provider ? provider.name : '?'} / ${cfg.model || '(未设置)'}`)
  console.log(`  API Key   ${getApiKey(cfg.providerId).key ? '已设置' : '未设置 —— 打开模型设置填一下'}`)
  console.log('  ────────────────────────────────────────────')
  console.log('  在 WPS 里打开「AI 助手」即可使用。这个窗口别关。')
  console.log('')
  log('就绪')
})

process.on('SIGINT', () => { log('收到退出信号，关闭服务'); server.close(() => process.exit(0)) })
