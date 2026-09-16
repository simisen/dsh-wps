/**
 * 文档工具的定义。
 *
 * 这些 schema 会被翻译成各厂商的 function calling 格式，交给模型去选。
 * 描述文字是给**模型**看的，不是给人看的 —— 所以要写清楚"什么时候用它"，
 * 而不只是"它是什么"。模型选错工具，多半是描述写得太含糊。
 */

export const DOC_TOOLS = [
  {
    name: 'get_document_info',
    description: '获取当前 WPS 文档的基本信息：文件名、当前有没有选中内容、选中有多少字、文档总字数。不确定该用哪个工具时，先调这个。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_selection',
    description: '读取用户在 WPS 里当前选中的文字。当用户说"这段""选中部分""帮我改改上面那段"时，用它拿到原文。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_document_text',
    description: '读取当前文档的正文文字。文档很长时只返回开头部分，并在结果里说明是否被截断。只在需要通读全文时才用，优先用 get_selection。',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: '最多返回多少字符。默认 4000，上限 20000。' }
      },
      required: []
    }
  },
  {
    name: 'replace_selection',
    description: '用新文字替换用户当前选中的内容。用户要求改写、润色、翻译、精简选中的段落时用它。调用前请确认选中的确实是目标内容（可先用 get_selection 看一眼）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '替换后的完整新文字。不要写"改写后如下："这类前缀，只给正文。' }
      },
      required: ['text']
    }
  },
  {
    name: 'insert_text',
    description: '在光标位置插入文字，不替换任何已有内容。用户要求"续写""在这里补一段""接着写"时用它。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要插入的文字' }
      },
      required: ['text']
    }
  },
  {
    name: 'replace_all',
    description: '在整篇文档里查找并替换文字。适合批量统一某个词（比如把"用户"全改成"客户"）。替换前会返回命中数量。',
    parameters: {
      type: 'object',
      properties: {
        find: { type: 'string', description: '要查找的文字' },
        replace: { type: 'string', description: '替换成什么' },
        matchCase: { type: 'boolean', description: '是否区分大小写，默认不区分' }
      },
      required: ['find', 'replace']
    }
  }
]

/** 转成 Anthropic 的 tool 格式（input_schema 而不是 parameters） */
export function toAnthropicTools (tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

/** 转成 OpenAI 的 tools 格式 */
export function toOpenAITools (tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/** 会修改文档的工具 —— 用于决定要不要开修订、要不要打点提示 */
export const WRITE_TOOLS = new Set(['replace_selection', 'insert_text', 'replace_all'])

/** 给模型的行为约束。放在 system prompt 里。 */
export const TOOL_SYSTEM_RULES = [
  '你可以调用工具直接读写用户正在编辑的 WPS 文档。',
  '',
  '使用工具的原则：',
  '1. 用户提到"这段""选中部分"时，先用 get_selection 拿到原文，不要凭空猜内容。',
  '2. 要修改文档，必须调用 replace_selection / insert_text / replace_all，不要只在聊天里给出改写结果让用户自己复制。',
  '3. 改动已在 WPS 里以「修订」形式出现，用户会逐条接受或拒绝，所以你不需要在回复里重复粘贴改后的全文。',
  '4. 改完后用一两句话说明你改了什么。注意：这是指**收尾说明**要短，不是指写进文档的内容要短 ——',
  '   写进文档的正文该多长就多长。',
  '5. 如果用户没有选中内容却要求改写，先问清楚要改哪一段，不要擅自改动整篇文档。',
  '6. 涉及删除、批量替换这类影响面大的操作，先用一句话说明你的意图再执行。'
].join('\n')
