/**
 * /asr polish endpoint client (two-stage LLM polish, runs host-side).
 */

export type PolishMode = 'polish' | 'correct' | 'format'

export interface PolishChannel {
  polish(payload: { text: string; mode: PolishMode }): Promise<{ text: string; provider: string; model: string }>
}
