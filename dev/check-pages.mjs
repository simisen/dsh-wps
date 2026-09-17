/**
 * 页面静态校验器 —— 不依赖浏览器。
 *
 * WPS 的加载项页面跑在它的 CEF 里，开发时未必有浏览器可用，
 * 所以这里做两层静态检查，能在改完代码后立刻发现问题：
 *
 *   1. 内联 <script> 的语法检查（用 new Function 编译，不执行）
 *   2. 交叉校验：JS 里引用的每个元素 id 必须在 HTML 里真的存在
 *      —— 拼错 id 是最常见、也最难在 WPS 里排查的低级错误
 *
 * 用法： node dev/check-pages.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADDON = path.resolve(__dirname, '..', 'addon')

const PAGES = [
  'addon/ui/chat.html',
  'addon/ui/settings.html',
  'addon/index.html'
]
const SCRIPTS = [
  'addon/js/api.js',
  'addon/js/doc.js',
  'addon/js/bootstrap.js',
  'addon/main.js'
]

let pass = 0, fail = 0
const ok = (m) => { console.log('  OK    ' + m); pass++ }
const bad = (m) => { console.log('  FAIL  ' + m); fail++ }

function extractInlineScripts(html) {
  const out = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) out.push(m[1])
  return out
}

function checkSyntax(label, code) {
  try {
    // 只编译不执行
    new Function(code)
    ok(label)
  } catch (e) {
    bad(label + '  ->  ' + e.message)
  }
}

console.log('')
console.log('  页面静态校验')
console.log('  ' + '-'.repeat(60))

/* ---- 独立脚本文件 ---- */
for (const rel of SCRIPTS) {
  const full = path.join(ADDON, rel.replace(/^addon\//, ''))
  const code = fs.readFileSync(full, 'utf8')
  checkSyntax(rel + ' 语法', code)
}

/* ---- 页面内联脚本 + id 交叉校验 ---- */
for (const rel of PAGES) {
  const full = path.join(ADDON, rel.replace(/^addon\//, ''))
  const html = fs.readFileSync(full, 'utf8')

  const inline = extractInlineScripts(html)
  if (inline.length === 0) {
    ok(rel + ' 内联脚本（无）')
  } else {
    inline.forEach((code, i) => {
      if (!code.trim()) return
      checkSyntax(`${rel} 内联脚本#${i + 1} 语法`, code)
    })
  }

  // 收集 HTML 里声明的所有 id
  const ids = new Set()
  const idRe = /\bid\s*=\s*"([^"]+)"/g
  let m
  while ((m = idRe.exec(html)) !== null) ids.add(m[1])

  // 收集 JS 里引用的所有 id
  const used = new Set()
  const useRes = [
    /getElementById\(\s*'([^']+)'\s*\)/g,
    /getElementById\(\s*"([^"]+)"\s*\)/g,
    /\$\(\s*'([^']+)'\s*\)/g
  ]
  for (const re of useRes) {
    let mm
    while ((mm = re.exec(html)) !== null) used.add(mm[1])
  }

  const missing = [...used].filter(x => !ids.has(x))
  if (missing.length === 0) {
    ok(`${rel} 元素 id 全部匹配（引用 ${used.size} 个）`)
  } else {
    bad(`${rel} 引用了不存在的 id: ${missing.join(', ')}`)
  }

  // 反向：页面里有没有 <script src> 指向不存在的本地文件
  const srcRe = /<script[^>]*\bsrc\s*=\s*"([^"]+)"/g
  let s
  while ((s = srcRe.exec(html)) !== null) {
    const src = s[1]
    if (/^https?:/.test(src)) continue
    const target = path.join(ADDON, src.replace(/^\//, ''))
    if (fs.existsSync(target)) ok(`${rel} 引用的脚本存在: ${src}`)
    else bad(`${rel} 引用了不存在的脚本: ${src}`)
  }
}

/* ---- 加载项被 WPS 读取的关键文件必须存在 ---- */
for (const f of ['manifest.xml', 'ribbon.xml', 'index.html', 'main.js']) {
  if (fs.existsSync(path.join(ADDON, f))) ok('加载项必需文件存在: ' + f)
  else bad('缺少加载项必需文件: ' + f)
}

/* ---- ribbon.xml 控件属性冲突检查 ----
   实测教训：一个控件同时写 label 和 getLabel，WPS 会**静默拒绝**整份 ribbon.xml ——
   没有报错、标签页不出现、onLoad 也不触发，看起来像整个加载项死了一样。
   这个检查就是为了别踩第二次。 */
try {
  const ribbon = fs.readFileSync(path.join(ADDON, 'ribbon.xml'), 'utf8')
  const PAIRS = [
    ['label', 'getLabel'],
    ['visible', 'getVisible'],
    ['enabled', 'getEnabled'],
    ['image', 'getImage'],
    ['screentip', 'getScreentip'],
    ['supertip', 'getSupertip']
  ]
  const conflicts = []
  const ctrlRe = /<(button|toggleButton|checkBox|dropDown|comboBox|editBox|labelControl|menu|dynamicMenu|gallery)\b([^>]*?)\/?>/gi
  let c
  while ((c = ctrlRe.exec(ribbon)) !== null) {
    const attrs = c[2]
    const idm = /\bid\s*=\s*"([^"]+)"/.exec(attrs)
    const id = idm ? idm[1] : '(无 id)'
    for (const pair of PAIRS) {
      const hasPlain = new RegExp('\\b' + pair[0] + '\\s*=').test(attrs)
      const hasGetter = new RegExp('\\b' + pair[1] + '\\s*=').test(attrs)
      if (hasPlain && hasGetter) conflicts.push(id + ' 同时有 ' + pair[0] + ' 和 ' + pair[1])
    }
  }
  if (conflicts.length === 0) ok('ribbon 控件无属性冲突（label/getLabel 之类）')
  else bad('ribbon 属性冲突会让整个加载项静默失效 -> ' + conflicts.join('; '))
} catch (e) {
  bad('ribbon 属性冲突检查失败: ' + e.message)
}

/* ---- ribbon.xml 的 onLoad / onAction 回调必须在 JS 里有定义 ---- */
try {
  const ribbon = fs.readFileSync(path.join(ADDON, 'ribbon.xml'), 'utf8')
  const boot = fs.readFileSync(path.join(ADDON, 'js', 'bootstrap.js'), 'utf8')
  const cbs = new Set()
  const cbRe = /\b(onLoad|onAction|getLabel|getImage|getVisible|getEnabled)\s*=\s*"([A-Za-z0-9_]+)"/g
  let c
  while ((c = cbRe.exec(ribbon)) !== null) cbs.add(c[2])
  const missing = [...cbs].filter(fn => !new RegExp('function\\s+' + fn + '\\s*\\(').test(boot))
  if (missing.length === 0) ok('ribbon 回调全部已实现: ' + [...cbs].join(', '))
  else bad('ribbon 引用了未实现的回调: ' + missing.join(', '))
} catch (e) {
  bad('ribbon 回调校验失败: ' + e.message)
}

/* ---- 面向用户的 .cmd / .ps1 编码检查 ----
   实测教训（两个坑都只在换机器时才暴露）：

   1) cmd.exe 按本机 OEM 代码页（中文机器是 936）逐字节读批处理文件。
      写进 .cmd 的 UTF-8 中文会显示成乱码，开头的 UTF-8 BOM 还会让
      第一行报 `'ï»¿@echo' 不是内部或外部命令`。
      → .cmd 必须纯 ASCII、无 BOM，中文提示一律放 .ps1。

   2) PowerShell 5.1 读 .ps1 时，没有 BOM 就按本机 ANSI 代码页解码，
      中文同样会乱成一团，而且**经常连带吃掉后面的引号**，
      报出来的是"意外的标记 }"这种完全指错方向的语法错误。
      → .ps1 必须带 UTF-8 BOM。 */
try {
  const root = path.resolve(__dirname, '..')
  const cmdFiles = fs.readdirSync(root).filter(f => f.toLowerCase().endsWith('.cmd'))
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF])

  let cmdBad = 0
  for (const f of cmdFiles) {
    const buf = fs.readFileSync(path.join(root, f))
    if (buf.subarray(0, 3).equals(BOM)) { bad(`${f} 带 UTF-8 BOM，cmd.exe 会把它当命令的一部分`); cmdBad++ }
    const high = buf.findIndex(b => b > 127)
    if (high !== -1) { bad(`${f} 含非 ASCII 字节（偏移 ${high}），cmd.exe 会显示成乱码`); cmdBad++ }
    // cmd.exe 是按行解析的，官方预期 CRLF。裸 LF 在含括号块/标签的批处理里会出怪问题，
    // 而这类问题只在别人机器上偶发 —— 不如统一钉成 CRLF。
    const text = buf.toString('latin1')
    if (/(^|[^\r])\n/.test(text)) { bad(`${f} 用了裸 LF 换行，批处理应当统一 CRLF`); cmdBad++ }
  }
  if (cmdFiles.length && cmdBad === 0) ok(`面向用户的 ${cmdFiles.length} 个 .cmd 都是纯 ASCII、无 BOM、CRLF`)

  const instDir = path.join(root, 'installer')
  const psFiles = fs.readdirSync(instDir).filter(f => f.toLowerCase().endsWith('.ps1'))
  let psBad = 0
  for (const f of psFiles) {
    const buf = fs.readFileSync(path.join(instDir, f))
    if (!buf.subarray(0, 3).equals(BOM)) { bad(`installer/${f} 缺 UTF-8 BOM，PowerShell 5.1 会把中文读成乱码`); psBad++ }
    if (/(^|[^\r])\n/.test(buf.toString('latin1'))) { bad(`installer/${f} 用了裸 LF 换行，应当统一 CRLF`); psBad++ }
  }
  if (psFiles.length && psBad === 0) ok(`installer 下 ${psFiles.length} 个 .ps1 都带 UTF-8 BOM 且是 CRLF`)

  /* .cmd 里提到的 .ps1 必须真的存在 —— 改名最容易漏掉这里 */
  for (const f of cmdFiles) {
    const text = fs.readFileSync(path.join(root, f), 'utf8')
    const re = /-File\s+"%~dp0([^"]+)"/g
    let m
    while ((m = re.exec(text)) !== null) {
      const target = path.join(root, m[1].replace(/\//g, path.sep))
      if (fs.existsSync(target)) ok(`${f} 转发的脚本存在: ${m[1]}`)
      else bad(`${f} 转发的脚本不存在: ${m[1]}`)
    }
  }
} catch (e) {
  bad('.cmd/.ps1 编码检查失败: ' + e.message)
}

console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
process.exit(fail > 0 ? 1 : 0)
