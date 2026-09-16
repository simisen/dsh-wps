const BASE = 'http://127.0.0.1:43130'
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())

console.log('=== 拉取模型列表：模拟网关（应成功）===')
const a = await post('/api/models', { providerId: 'custom', baseURL: 'http://127.0.0.1:43199/v1', model: 'x', apiKey: 'fixture-mock' })
console.log('  ok=' + a.ok + ' count=' + (a.count || 0) + ' models=' + JSON.stringify(a.models))

console.log('=== 拉取模型列表：真实 DeepSeek + 假 Key（应给人话错误）===')
const b = await post('/api/models', { providerId: 'deepseek', model: 'x', apiKey: 'fixture-definitely-not-a-credential' })
console.log('  ok=' + b.ok + ' short=' + b.short + ' hint=' + (b.hint || ''))

console.log('=== 拉取模型列表：地址不通（应给人话）===')
const c = await post('/api/models', { providerId: 'custom', baseURL: 'http://127.0.0.1:59998/v1', model: 'x', apiKey: 'k' })
console.log('  ok=' + c.ok + ' short=' + c.short)
