/**
 * 厂商预设。
 *
 * 设计要点：
 *  - 用户选中厂商后，baseURL / 协议自动填好，只需要粘贴 Key。
 *  - 模型名会随厂商更新而过时，所以界面上模型是「可编辑输入框 + 预设做候选」，
 *    不是只读下拉框 —— 否则厂商出新模型就得改代码发版。
 *  - api 字段决定用哪种协议：
 *      'openai'    → POST {baseURL}/chat/completions，Authorization: Bearer
 *      'anthropic' → POST {baseURL}/messages，x-api-key + anthropic-version
 *    绝大多数国内厂商都提供 OpenAI 兼容接口，所以 'openai' 是主力。
 */

export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyURL: 'https://platform.deepseek.com/api_keys',
    note: '官方直连，有峰谷价（工作日 18:00–次日 9:00 与周末全天为谷时）'
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    api: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
    note: '长文本见长'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    api: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyURL: 'https://bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度'
  },
  {
    id: 'dashscope',
    name: '通义 / DashScope',
    api: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    keyURL: 'https://bailian.console.aliyun.com/',
    note: '阿里百炼，用的是「兼容模式」端点'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    api: 'openai',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    keyURL: 'https://cloud.siliconflow.cn/account/ak',
    note: '聚合平台，一个 Key 可调很多开源模型'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    keyURL: 'https://platform.openai.com/api-keys',
    note: '国内访问通常需要代理'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    keyURL: 'https://console.anthropic.com/settings/keys',
    note: '独立协议（非 OpenAI 兼容），本服务已单独适配'
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    api: 'openai',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5', 'llama3.1'],
    keyURL: 'https://ollama.com/download',
    needsKey: false,
    note: '本地跑模型，不用 Key、不花钱，但需要显卡和内存'
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    api: 'openai',
    baseURL: '',
    models: [],
    keyURL: '',
    note: '任何 OpenAI 兼容网关：把 baseURL 填到 /v1 为止'
  }
]

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || null
}

/** 供前端渲染用的安全副本（不含任何密钥信息） */
export function providersForClient() {
  return PROVIDERS.map(p => ({ ...p }))
}
