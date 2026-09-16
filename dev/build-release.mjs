/**
 * 打包发布 —— 生成一个可以发给别人的 zip。
 *
 * 这个东西存在的唯一理由是安全：
 *   这个项目要开源分享，而**作者自己的 API Key 就存在本机**。
 *   手工打包太容易把 credentials.json / 日志 / 运行数据一起塞进去。
 *   所以打包流程里加了强制扫描 —— 扫到疑似密钥就**直接失败**，不出包。
 *
 * 用法： node dev/build-release.mjs
 * 产物： dist/dsh-wps-<版本>.zip
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

/* ---- 1. 哪些东西绝对不能进包 ---- */
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', 'runtime', 'testhome', 'testhome-isolated'])
const EXCLUDE_FILES = new Set(['credentials.json', '.env', 'package-lock.json'])
const EXCLUDE_EXT = new Set(['.log', '.key', '.pem', '.zip', '.7z', '.tmp'])

/* ---- 2. 疑似密钥的特征 ---- */
const SECRET_PATTERNS = [
  { name: 'sk- 开头的密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9_-]{20,}/ },
  { name: 'apiKey 长赋值', re: /api[_-]?key["'\s:=]{1,4}[A-Za-z0-9_-]{24,}/i },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '本机用户名路径', re: /C:\\Users\\[A-Za-z0-9_.-]+\\AppData/i }
]

/* 明显是占位/夹具的值，跳过 —— 否则测试文件里的假 Key 会把扫描变成"狼来了"，
   久而久之就没人看扫描结果了。真正的 Key 是随机串，不会含这些词。 */
const FAKE_MARKERS = [
  'not-a-credential', 'not-a-real', 'fake', 'dummy', 'fixture',
  'example', 'placeholder', 'your-key', 'yourkey', 'test-key', 'xxxx'
]
function looksFake (s) {
  const l = String(s).toLowerCase()
  return FAKE_MARKERS.some(m => l.includes(m))
}

let pass = 0
let fail = 0
const ok = (m) => { console.log('  OK    ' + m); pass++ }
const bad = (m) => { console.log('  FAIL  ' + m); fail++ }

console.log('')
console.log('  打包发布')
console.log('  ' + '-'.repeat(60))

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'

/* ---- 3. 先把源目录扫一遍 ---- */
console.log('  [1/4] 扫描源目录里的密钥…')
const suspects = []
function scanFile (full, rel) {
  let text
  try {
    const buf = fs.readFileSync(full)
    if (buf.includes(0)) return            // 二进制跳过
    text = buf.toString('utf8')
  } catch { return }
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text)
    if (m && !looksFake(m[0])) suspects.push({ rel, kind: p.name, sample: m[0].slice(0, 12) + '…' })
  }
}

function walk (dir, relBase = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? relBase + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), rel)
    } else {
      if (EXCLUDE_FILES.has(e.name) || EXCLUDE_EXT.has(path.extname(e.name).toLowerCase())) continue
      scanFile(path.join(dir, e.name), rel)
    }
  }
}
walk(ROOT)

if (suspects.length === 0) {
  ok('源目录没有任何疑似密钥')
} else {
  for (const s of suspects) bad(`疑似密钥：${s.rel}  (${s.kind}  ${s.sample})`)
  console.log('')
  console.log('  ✘ 扫描不通过，拒绝打包。请先把上面的文件清理干净。')
  process.exit(1)
}

/* ---- 4. 复制到 dist ---- */
console.log('  [2/4] 复制文件…')
fs.rmSync(DIST, { recursive: true, force: true })
const stage = path.join(DIST, 'dsh-wps')
fs.mkdirSync(stage, { recursive: true })

let copied = 0
function copy (dir, relBase = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? relBase + '/' + e.name : e.name
    const src = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      fs.mkdirSync(path.join(stage, rel), { recursive: true })
      copy(src, rel)
    } else {
      if (EXCLUDE_FILES.has(e.name) || EXCLUDE_EXT.has(path.extname(e.name).toLowerCase())) continue
      fs.copyFileSync(src, path.join(stage, rel))
      copied++
    }
  }
}
copy(ROOT)
ok(`复制了 ${copied} 个文件`)

/* ---- 5. 再扫一遍成品（防止有东西在复制过程中被带进来）---- */
console.log('  [3/4] 复扫成品…')
const suspects2 = []
function scanStage (dir, relBase = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? relBase + '/' + e.name : e.name
    if (e.isDirectory()) scanStage(path.join(dir, e.name), rel)
    else {
      const buf = fs.readFileSync(path.join(dir, e.name))
      if (buf.includes(0)) continue
      const text = buf.toString('utf8')
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(text)
        if (m && !looksFake(m[0])) suspects2.push({ rel, kind: p.name })
      }
    }
  }
}
scanStage(stage)
if (suspects2.length === 0) ok('成品里没有任何疑似密钥')
else {
  for (const s of suspects2) bad(`成品含疑似密钥：${s.rel} (${s.kind})`)
  fs.rmSync(DIST, { recursive: true, force: true })
  process.exit(1)
}

/* ---- 6. 打 zip ---- */
console.log('  [4/4] 打包…')
const zipName = `dsh-wps-${version}.zip`
const zipPath = path.join(DIST, zipName)
try {
  execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', DIST, 'dsh-wps'], { stdio: 'inherit' })
  const size = fs.statSync(zipPath).size
  ok(`已生成 dist/${zipName}  (${(size / 1024).toFixed(1)} KB)`)
} catch (e) {
  bad('打 zip 失败: ' + e.message)
}

/* ---- 清理 staging ---- */
fs.rmSync(stage, { recursive: true, force: true })

console.log('')
console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
if (fail === 0) {
  console.log('  这个 zip 可以直接发给别人：解压 → 双击 install.cmd 即可。')
  console.log('  内含：加载项 + 本地服务 + 安装脚本 + 文档 + AGPL 许可')
  console.log('  不含：任何密钥、配置、日志、运行数据')
}
console.log('')
process.exit(fail > 0 ? 1 : 0)
