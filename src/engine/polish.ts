/**
 * Two-stage polish: after local ASR transcribes the utterance, an LLM pass
 * removes disfluencies and fixes self-corrections. Runs on the host through
 * the harness LLM route (default model selection), never through the
 * browser, so no transcription leaves the machine unless the user's LLM
 * endpoint itself is remote (same trust boundary as any chat turn).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export type PolishMode = 'polish' | 'correct' | 'format'

export interface PolishRequest {
  text: string
  mode?: PolishMode
}

export interface PolishResult {
  text: string
  provider: string
  model: string
}

interface DefaultModelLike {
  provider?: string
  model?: string
}

const MODE_PROMPTS: Record<PolishMode, (text: string) => string> = {
  // 最小化润色：去口头禅/填充词、合并重复、整合自我修正，保原意与风格
  polish: text => [
    '你是语音转写润色助手。请对下面这段由语音识别（ASR）生成的文本做最小化润色，'
    + '只做明确、非内容性的修改，其他一律保持原样。',
    '',
    '要求：',
    '1. 删除无信息量的填充词（如"呃""嗯""那个""就是说"）。',
    '2. 合并无意义的重复与口吃（如"我我我觉得"→"我觉得"）。',
    '3. 整合自我修正：说话人明确改口时只保留最终说法（如"周三开会，呃不对，是周四"→"周四开会"）。',
    '4. 修正明显的同音错别字与基础语法错误，但不改写句式、语气或用词风格。',
    '5. 拿不准时保守处理：不确定就保持原文。',
    '6. 直接输出润色后的文本，不要任何解释、前后缀或 markdown 代码块。',
    '',
    `待润色文本：\n${text}`,
  ].join('\n'),

  // 纠错：仅纠正错别字/语法/识别错误，保留全部内容
  correct: text => [
    '请纠正下面语音识别文本中的错别字、语法错误和识别错误，保持原意与结构完全不变，'
    + '不要增删内容、不要改写风格。直接输出纠正后的文本，不要任何解释。',
    '',
    `待纠正文本：\n${text}`,
  ].join('\n'),

  // 格式化：加标点分段，方便粘贴为邮件/文档
  format: text => [
    '请将下面语音识别文本整理成适合阅读的书面格式：补全标点、按语义分段（必要时用空行），'
    + '不改写任何词句。直接输出整理后的文本，不要任何解释。',
    '',
    `待整理文本：\n${text}`,
  ].join('\n'),
}

/**
 * Run one LLM polish pass. Throws with a descriptive message when the
 * deployment has no default model configured.
 */
export async function polishText(ctx: Context, request: PolishRequest): Promise<PolishResult> {
  const selection = ctx.agentDefaultModel.currentSelection() as DefaultModelLike
  const provider = selection.provider ?? ''
  const model = selection.model ?? ''
  if (provider === '' || model === '') {
    throw new Error('当前没有配置默认模型，无法执行润色')
  }
  const mode: PolishMode = request.mode === 'correct' || request.mode === 'format' ? request.mode : 'polish'
  const prompt = MODE_PROMPTS[mode](request.text)

  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-voice-funasr' },
  })

  let output = ''
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages: [message],
    temperature: 0.3,
    maxTokens: 2048,
  })) {
    if (chunk.type === 'text-delta') output += chunk.text
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error(`润色失败：${chunk.reason.failure.message}`)
    }
    if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
      throw new Error('润色已中止')
    }
  }
  const text = output.trim()
  if (text === '') throw new Error('润色返回了空文本')
  return { text, provider, model }
}
