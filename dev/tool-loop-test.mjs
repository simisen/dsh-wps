/**
 * 工具调用链端到端测试 —— 这是「助手真的能改文档」的证明。
 *
 * 链路：
 *   模拟模型（脚本化返回 tool_calls）
 *     → 本地服务 agent 循环
 *     → SSE 把 tool 事件推给侧栏
 *     → 侧栏用（模拟的）WPS JSAPI 改文档
 *     → POST 结果回服务
 *     → 循环继续 → 模型收尾
 *
 * 断言的是**文档对象真的被改了**、**撤销打包真的开了又关**，
 * 而不是"函数被调用了"。
 *
 * 前置：本地服务在跑；模拟模型在跑（node dev/mock-llm.mjs）
 * 用法：node dev/tool-loop-test.mjs
 */
import { runPageSync, makeFakeWord, sleep, textOf, BASE } from './sim-env.mjs'

const MOCK_LLM = process.env.DSH_WPS_MOCK_LLM || 'http://127.0.0.1:43199/v1'

let pass = 0, fail = 0
const ok = (m) => { console.log('  OK    ' + m); pass++ }
const bad = (m) => { console.log('  FAIL  ' + m); fail++ }

console.log('')
console.log('  工具调用链端到端测试')
console.log('  服务: ' + BASE)
console.log('  模拟模型: ' + MOCK_LLM)
console.log('  ' + '-'.repeat(60))

/* ---- 前置检查 ---- */
try {
  const p = await (await fetch(BASE + '/api/ping')).json()
  if (!p.ok) throw new Error('ping 失败')
} catch (e) {
  console.log('  ✘ 本地服务没在跑：node server/index.mjs')
  process.exit(1)
}
try {
  await fetch(MOCK_LLM.replace(/\/v1$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] })
  })
} catch (e) {
  console.log('  ✘ 模拟模型没在跑：node dev/mock-llm.mjs')
  process.exit(1)
}

/* ---- 把服务指向模拟模型 ---- */
const ORIGINAL = await (await fetch(BASE + '/api/config')).json()
const save = async (body) => (await fetch(BASE + '/api/config', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
})).json()

await save({
  providerId: 'custom',
  baseURL: MOCK_LLM,
  model: 'mock-model',
  apiKey: 'fixture-mock-not-real',
  writeMode: 'track'
})
ok('已把服务指向模拟模型（provider=custom, model=mock-model）')

/* ---- 造一个假文档 + 假 WPS 环境 ---- */
const REPLACED = '改写过的示例文字'
const EXPECTED = '这是一段改写过的示例文字。'
const fake = makeFakeWord({
  text: '这是一段原始的示例文字。',
  selection: '原始的示例文字',
  docName: '端到端测试.docx'
})

const { env, crashed } = runPageSync('ui/chat.html', 'chat.html', { Application: fake.app })
if (crashed) { bad('chat.html 执行期抛异常: ' + crashed); process.exit(1) }
ok('chat.html 已加载（注入模拟的 WPS Application）')

await sleep(2000)
if (env.errors.length) bad('加载期触发 alert: ' + env.errors.join(' | '))
else ok('加载期无 alert')

/* ---- 回归：点「设置」时侧栏不应自己开窗 ---- */
// 之前的 bug：侧栏的 openSettings 既广播、又"兜底"直接调 ShowDialog，
// 两条都成功 → 一次点击开出两个一模一样的设置窗。
env.ids.get('btnSettings').onclick()
await sleep(600)
const directDialogs = fake.calls.filter(c => c.op === 'show_dialog').length
if (directDialogs === 0) ok('点「设置」只走广播，侧栏没有重复开窗')
else bad('侧栏直接开了 ' + directDialogs + ' 个设置窗 —— 会和加载项广播叠成两个')

/* ---- 发一条消息，走完整轮 ---- */
console.log('    · 发送消息，等待整轮跑完…')
env.ids.get('input').value = '把选中的这段改一下'
env.ids.get('btnSend').onclick()

const deadline = Date.now() + 20000
while (Date.now() < deadline) {
  await sleep(300)
  if (fake.text === EXPECTED && fake.state.undo.ends > 0) break
}

console.log('')
console.log('  --- 文档对象状态 ---')
console.log('  改前  : 这是一段原始的示例文字。')
console.log('  改后  : ' + fake.text)
console.log('  撤销记录: StartCustomRecord×' + fake.state.undo.starts + '  EndCustomRecord×' + fake.state.undo.ends)
console.log('  修订开关切换次数: ' + fake.state.trackToggleCount)
console.log('  文档操作: ' + JSON.stringify(fake.calls.filter(c => c.op !== 'set_track_revisions')))
console.log('')

/* ---- 断言 ---- */
if (fake.text === EXPECTED) ok('文档内容被真的改成了模型指定的文字')
else bad('文档内容不对：期望 ' + JSON.stringify(EXPECTED) + '，实际 ' + JSON.stringify(fake.text))

if (fake.state.writes.length >= 1) ok('记录到 ' + fake.state.writes.length + ' 次实际写入')
else bad('一次写入都没有发生')

if (fake.state.undo.starts >= 1) ok('整轮撤销记录已开启（StartCustomRecord×' + fake.state.undo.starts + '）')
else bad('没有开启自定义撤销记录 —— 用户按 Ctrl+Z 会逐个撤而不是整轮退')

if (fake.state.undo.ends >= 1) ok('整轮撤销记录已关闭（EndCustomRecord×' + fake.state.undo.ends + '）')
else bad('自定义撤销记录没有关闭 —— 会一直挂在撤销栈上')

if (fake.state.trackToggleCount >= 2 && fake.state.trackRevisions === false) {
  ok('修订留痕：开了又关，最终已复原（切换 ' + fake.state.trackToggleCount + ' 次）')
} else {
  bad('修订留痕状态不对：切换 ' + fake.state.trackToggleCount + ' 次，最终值=' + fake.state.trackRevisions)
}

const msgs = env.ids.get('messages')
const allText = textOf(msgs)
if (allText.indexOf('改完了') >= 0) ok('模型收尾文本已渲染到侧栏')
else bad('侧栏里没看到模型收尾文本，实际：' + JSON.stringify(allText.slice(0, 120)))

const banner = env.ids.get('banner')
if (banner.classList.contains('hidden')) ok('没有出现错误横幅')
else bad('出现了错误横幅：' + textOf(banner).slice(0, 120))

if (env.errors.length) bad('过程中触发 alert: ' + env.errors.join(' | '))
else ok('全过程没有 alert')

/* ---- 最大输出长度真的传出去了吗 ----
   用户反馈过"输出不了长文本"，根因是这里被写死在 2048。 */
try {
  const last = await (await fetch(MOCK_LLM.replace(/\/v1$/, '') + '/last')).json()
  if (typeof last.max_tokens === 'number' && last.max_tokens >= 8192) {
    ok('服务把 max_tokens=' + last.max_tokens + ' 传给了厂商（不再卡在 2048）')
  } else {
    bad('max_tokens 只有 ' + last.max_tokens + ' —— 长文本会被截断')
  }
} catch (e) {
  bad('读不到模拟模型的最后请求: ' + e.message)
}

/* ---- 还原配置 ---- */
await save({
  providerId: ORIGINAL.providerId,
  baseURL: ORIGINAL.baseURL,
  model: ORIGINAL.model,
  writeMode: ORIGINAL.writeMode
})
ok('已还原服务配置')

console.log('')
console.log('  ' + '-'.repeat(60))
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('')
process.exit(fail > 0 ? 1 : 0)
