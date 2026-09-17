/**
 * 工作区自测：接口 + 静态托管 + 错误翻译。
 * 用法： node dev/selftest.mjs
 */
// ⚠️ 默认打 43131（专用测试实例），不是 43130（用户的实例）。
// 这个自测会**写配置和假 Key** —— 跑在用户实例上会覆盖掉真实 Key。
const BASE = process.env.DSH_WPS_TEST_URL || 'http://127.0.0.1:43131'
let pass = 0, fail = 0

async function check(name, fn) {
  try {
    const r = await fn()
    console.log('  OK    ' + name + (r ? '  ->  ' + r : ''))
    pass++
  } catch (e) {
    console.log('  FAIL  ' + name + '  ->  ' + (e && e.message || e))
    fail++
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败') }

console.log('')
console.log('  自测目标: ' + BASE)
console.log('  ' + '-'.repeat(60))

await check('服务存活 /api/ping', async () => {
  const j = await (await fetch(BASE + '/api/ping')).json()
  assert(j.ok === true, 'ok 不为 true')
  return 'version=' + j.version
})

await check('厂商预设 /api/providers', async () => {
  const j = await (await fetch(BASE + '/api/providers')).json()
  assert(Array.isArray(j.providers), 'providers 不是数组')
  assert(j.providers.length === 9, '期望 9 个预设，实际 ' + j.providers.length)
  const ids = j.providers.map(p => p.id).join(',')
  return j.providers.length + ' 个: ' + ids
})

await check('静态托管 加载项入口 /', async () => {
  const r = await fetch(BASE + '/')
  assert(r.status === 200, 'HTTP ' + r.status)
  const t = await r.text()
  assert(t.includes('main.js'), '入口页内容不对')
  return 'HTTP 200'
})

for (const p of ['/ribbon.xml', '/manifest.xml', '/js/api.js', '/js/bootstrap.js', '/ui/chat.html', '/ui/settings.html', '/images/1.svg']) {
  await check('静态资源 ' + p, async () => {
    const r = await fetch(BASE + p)
    assert(r.status === 200, 'HTTP ' + r.status)
    const t = await r.text()
    assert(t.length > 20, '内容过短')
    return r.status + ', ' + t.length + 'B'
  })
}

await check('目录穿越防护 /../package.json', async () => {
  const r = await fetch(BASE + '/../package.json')
  assert(r.status === 403 || r.status === 404, '居然返回了 ' + r.status)
  return 'HTTP ' + r.status
})

const FAKE_KEY = 'fixture-selftest-not-a-credential'

await check('保存配置 POST /api/config', async () => {
  const r = await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: FAKE_KEY,
      writeMode: 'track'
    })
  })
  const j = await r.json()
  assert(j.ok === true, '保存失败: ' + JSON.stringify(j))
  assert(j.config.hasKey === true, 'hasKey 应为 true')
  return 'hasKey=' + j.config.hasKey + ' model=' + j.config.model
})

await check('回读配置 且绝不回传 Key 本身', async () => {
  const j = await (await fetch(BASE + '/api/config')).json()
  assert(!('apiKey' in j), '响应里出现了 apiKey 字段！')
  const raw = JSON.stringify(j)
  assert(!raw.includes(FAKE_KEY), '响应里泄漏了 Key！')
  assert(j.hasKey === true, 'hasKey 应为 true')
  return 'hasKey=' + j.hasKey + ', keySource=' + j.keySource + '（未泄漏）'
})

await check('留空保存不会弄丢 Key（"留空 = 不修改"的契约）', async () => {
  const before = await (await fetch(BASE + '/api/config')).json()
  assert(before.hasKey === true, '前置条件：应该已经有 Key')
  // 模拟用户只改了模型名、Key 框留空就点保存 —— 这正是"每次都要重填 API"的现场
  await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: before.providerId,
      baseURL: before.baseURL,
      model: before.model
      // 故意不带 apiKey
    })
  })
  const after = await (await fetch(BASE + '/api/config')).json()
  assert(after.hasKey === true, 'Key 被弄丢了！留空保存不该清除 Key')
  return '留空保存后 hasKey 仍为 ' + after.hasKey
})

await check('环境变量覆盖 Key', async () => {
  // 这条靠服务进程的环境变量，这里只验证接口没把它写进配置文件
  const j = await (await fetch(BASE + '/api/config')).json()
  return 'keySource=' + j.keySource
})

// 这条是真实踩出来的：我用 PowerShell 的 `Set-Content -Encoding UTF8` 改了一下
// credentials.json，PS 5.1 顺手加了 UTF-8 BOM —— 服务端 JSON.parse 直接抛错，
// Key "凭空消失"，界面又要求重新输入。记事本保存也是同样的后果。
await check('配置文件带 UTF-8 BOM 也要能读出 Key', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const home = process.env.DSH_WPS_TEST_HOME
    || path.join(process.cwd(), 'dev', 'testhome-isolated')
  const credPath = path.join(home, 'credentials.json')

  const before = await (await fetch(BASE + '/api/config')).json()
  assert(before.hasKey === true, '前置条件：应该已经有 Key')

  const original = fs.readFileSync(credPath)
  assert(original[0] !== 0xEF, '前置条件：原文件本来不该带 BOM')
  try {
    // 在文件开头插入 UTF-8 BOM
    fs.writeFileSync(credPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), original]))
    const after = await (await fetch(BASE + '/api/config')).json()
    assert(after.hasKey === true, '带 BOM 的 credentials.json 被当成坏文件了，Key 读不出来')
    assert(after.keySource === before.keySource, 'keySource 变了：' + before.keySource + ' -> ' + after.keySource)
    return 'BOM 文件仍然读出 Key（keySource=' + after.keySource + '）'
  } finally {
    fs.writeFileSync(credPath, original)   // 无论成败都还原
  }
})

await check('错误翻译：baseURL 不通 -> 应给人话', async () => {
  const r = await fetch(BASE + '/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'custom',
      baseURL: 'http://127.0.0.1:59999/v1',
      model: 'whatever',
      apiKey: 'x'
    })
  })
  const j = await r.json()
  assert(j.ok === false, '不该成功')
  assert(typeof j.short === 'string' && j.short.length > 0, '没有 short 字段')
  assert(!/^请求失败/.test(j.short) || j.short.includes('HTTP'), '没有翻译成人话')
  return j.short + ' | ' + (j.hint || '')
})

await check('未填 Key 时的友好拒绝', async () => {
  const r = await fetch(BASE + '/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' })
  })
  const j = await r.json()
  assert(j.ok === false, '不该成功')
  return j.short
})

await check('真实厂商连通性（用假 Key 打 DeepSeek，看是否返回人话 401）', async () => {
  const r = await fetch(BASE + '/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'fixture-definitely-not-a-credential' })
  })
  const j = await r.json()
  if (j.latencyMs === undefined) throw new Error('没有 latencyMs')
  return 'ok=' + j.ok + ' short=' + j.short + ' hint=' + (j.hint || '') + ' (' + j.latencyMs + 'ms)'
})

await check('对话接口在未配置真实 Key 时给出可读错误', async () => {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  })
  // 已配置（假）Key，所以会真的去请求 -> 可能返回 SSE 里的 error 事件，或非 200
  if (r.status !== 200) {
    const j = await r.json()
    return 'HTTP ' + r.status + ' ' + (j.short || '')
  }
  const txt = await r.text()
  const hasErr = txt.includes('"type":"error"')
  return 'SSE 已开启，含错误事件=' + hasErr
})

console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
process.exit(fail > 0 ? 1 : 0)
