/**
 * Agent 运行时 —— 可替换的接缝。
 *
 * 现在只有一种实现：inproc（进程内循环）。
 * 以后接 DSH 时，只要再写一个实现挂到同一个接口上，
 * 上层（HTTP 路由、侧栏）完全不用改。
 *
 * 接口约定：
 *   run({ llm, history, userText, docContext, onEvent, executeTool, maxSteps })
 *     llm         { api, baseURL, apiKey, model, maxTokens, temperature }
 *     history     [{ role:'user'|'assistant', content }]
 *     userText    本轮用户输入
 *     docContext  附着在用户消息前的文档上下文（选区等）
 *     onEvent(evt) 产出事件：status / delta / tool / tool_result / done / error
 *     executeTool({ id, name, args }) -> { ok, text }
 *                  由调用方把工具请求转发到 WPS 侧栏去执行（文档操作只能在那边做）
 *   返回          { text, steps, toolCalls }
 */

import { streamTurn } from './toolchat.mjs'
import { DOC_TOOLS, TOOL_SYSTEM_RULES, WRITE_TOOLS } from './tools.mjs'

const BASE_SYSTEM = [
  '你是嵌入 WPS 文字的中文写作助手。',
  '',
  '【语言】',
  '全程使用简体中文，包括调用工具前后写的那一两句说明。不要夹英文句子。',
  '',
  '【关于铺垫话】',
  '调用工具前不要写"我来帮你""I\'ll…"这类开场白，直接调用工具。',
  '工具执行完再写收尾说明，一句话说清做了什么就行。',
  '',
  '【关于篇幅 —— 这条很重要】',
  '按任务的实际需要来，不要一律求短：',
  '- 用户问的是"回答"（这段好不好、什么毛病、用哪个），就一两句说完，不要客套、不要复述原文。',
  '- 用户要的是"内容"（续写、扩写、起草、写整段、写材料），就**放手写足**，',
  '  不要因为"简洁"而缩水 —— 这类任务用户要的就是完整的正文，写短了等于没做。',
  '- 判断方法：想一下用户拿到的应该是"一段回答"还是"可直接用的文字"。后者就给足。',
  '',
  TOOL_SYSTEM_RULES
].join('\n')

/** 工具结果太长的截断，避免把上下文撑爆 */
function trimToolResult (text, limit = 20000) {
  const s = String(text == null ? '' : text)
  if (s.length <= limit) return s
  return s.slice(0, limit) + `\n…（结果过长已截断，原长 ${s.length} 字）`
}

export function createInProcRuntime () {
  return {
    name: 'inproc',

    async run ({ llm, history = [], userText, docContext = '', onEvent, executeTool, maxSteps = 6 }) {
      const messages = [{ role: 'system', content: BASE_SYSTEM }]
      for (const m of history) {
        if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
          messages.push({ role: m.role, content: String(m.content) })
        }
      }
      messages.push({ role: 'user', content: docContext ? docContext + userText : userText })

      let assistantText = ''
      let steps = 0
      const allToolCalls = []

      while (steps < maxSteps) {
        steps++
        onEvent({ type: 'status', text: steps === 1 ? '正在思考…' : '正在整理结果…' })

        let roundText = ''
        let calls = null
        let failure = null
        let stopReason = ''

        for await (const evt of streamTurn({
          api: llm.api,
          baseURL: llm.baseURL,
          apiKey: llm.apiKey,
          model: llm.model,
          messages,
          tools: DOC_TOOLS,
          maxTokens: llm.maxTokens,
          temperature: llm.temperature
        })) {
          if (evt.type === 'delta') {
            roundText += evt.text
            // 工具调用之前的铺垫文字不往界面上推 —— 模型常常只是说"好的，我来改"
            if (!calls) onEvent({ type: 'delta', text: evt.text })
          } else if (evt.type === 'tool_calls') {
            calls = evt.calls
          } else if (evt.type === 'done') {
            stopReason = evt.stopReason
          } else if (evt.type === 'error') {
            failure = evt
          }
        }

        if (failure) {
          onEvent({ type: 'error', short: failure.short, hint: failure.hint, raw: failure.raw, status: failure.status })
          return { text: assistantText, steps, toolCalls: allToolCalls, failed: true }
        }

        if (!calls || !calls.length) {
          assistantText += roundText
          // 被长度上限截断：内容可能只写了一半。必须明说，
          // 否则用户会以为助手就只写这么点（"为什么它输出不了长文本"就是这么来的）。
          if (stopReason === 'length') {
            onEvent({
              type: 'notice',
              text: '输出到了长度上限，内容可能被截断。'
                + '可以在「模型设置 → 高级 → 最大输出长度」里调大，或让我分段继续写。'
            })
          }
          break
        }

        // ---- 执行工具 ----
        messages.push({ role: 'assistant', content: roundText || '', toolCalls: calls })

        for (const call of calls) {
          const isWrite = WRITE_TOOLS.has(call.name)
          onEvent({
            type: 'tool',
            id: call.id,
            name: call.name,
            args: call.args,
            isWrite,
            text: describeTool(call.name, isWrite)
          })

          let result
          try {
            result = await executeTool({ id: call.id, name: call.name, args: call.args || {} })
          } catch (e) {
            result = { ok: false, text: '工具执行失败：' + (e && e.message ? e.message : String(e)) }
          }

          allToolCalls.push({ id: call.id, name: call.name, args: call.args, ok: !!result.ok })
          onEvent({ type: 'tool_result', id: call.id, name: call.name, ok: !!result.ok, text: trimToolResult(result.text, 300) })

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: trimToolResult(result.text || (result.ok ? '完成' : '失败'))
          })
        }

        if (steps >= maxSteps) {
          onEvent({ type: 'status', text: '已达工具调用上限，收尾' })
        }
      }

      return { text: assistantText, steps, toolCalls: allToolCalls }
    }
  }
}

/** 给用户看的一句话状态，比"正在调用工具"友好 */
function describeTool (name, isWrite) {
  switch (name) {
    case 'get_document_info': return '正在读取文档信息…'
    case 'get_selection': return '正在读取你的选区…'
    case 'get_document_text': return '正在通读文档…'
    case 'replace_selection': return '正在改写选中内容…'
    case 'insert_text': return '正在插入内容…'
    case 'replace_all': return '正在批量替换…'
    default: return isWrite ? '正在修改文档…' : '正在读取文档…'
  }
}
