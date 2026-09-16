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

console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
process.exit(fail > 0 ? 1 : 0)
