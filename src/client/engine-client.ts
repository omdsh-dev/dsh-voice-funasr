/**
 * /asr RPC client wrapper: unwraps the Connection RpcResult envelope and
 * throws the server message on failure.
 */

import type { RpcChannelCall } from './context-types.ts'
import type { PolishMode } from './polish.ts'
import type { EngineSnapshot } from './asr.ts'

export interface EngineStatusValue {
  python: { command: string; found: boolean; version?: string; error?: string }
  process: string
  modelRoot: string
  missing?: string[]
  models?: Record<string, { ready: boolean; loaded: boolean; dir: string }>
  requestsTotal?: number
  lastError?: string
}

interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

export class EngineClient {
  private statusCache: EngineStatusValue | undefined
  private statusCacheAt = 0
  private readonly cacheTtlMs = 15_000

  constructor(private readonly rpc: RpcChannelCall) {}

  async status(): Promise<EngineStatusValue> {
    if (this.statusCache !== undefined && Date.now() - this.statusCacheAt < this.cacheTtlMs) {
      return this.statusCache
    }
    const value = await this.call('status', {}) as EngineStatusValue
    this.statusCache = value
    this.statusCacheAt = Date.now()
    return value
  }

  async probeEngine(): Promise<EngineSnapshot> {
    try {
      const status = await this.status()
      const missing = status.missing ?? []
      return {
        available: status.python.found && missing.length === 0,
        pythonFound: status.python.found,
        modelsMissing: missing,
        process: status.process,
      }
    } catch (error) {
      return {
        available: false,
        pythonFound: false,
        modelsMissing: ['status-failed'],
        process: 'unknown',
      }
    }
  }

  async transcribe(payload: { pcm16Base64: string; sampleRate: number; vad?: boolean; punc?: boolean }): Promise<{
    text: string
    rawText: string
    durationS: number
    elapsedMs: number
  }> {
    const value = await this.call('transcribe', {
      audio: { pcm16Base64: payload.pcm16Base64, sampleRate: payload.sampleRate },
      vad: payload.vad,
      punc: payload.punc,
    }) as { text?: unknown; rawText?: unknown; durationS?: unknown; elapsedMs?: unknown }
    if (typeof value.text !== 'string') throw new Error('engine returned an invalid transcribe result')
    return {
      text: value.text,
      rawText: typeof value.rawText === 'string' ? value.rawText : value.text,
      durationS: typeof value.durationS === 'number' ? value.durationS : 0,
      elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : 0,
    }
  }

  async polish(text: string, mode: PolishMode): Promise<{ text: string; provider: string; model: string }> {
    const value = await this.call('polish', { text, mode }) as { text?: unknown; provider?: unknown; model?: unknown }
    if (typeof value.text !== 'string' || value.text === '') throw new Error('polish returned an empty text')
    return {
      text: value.text,
      provider: typeof value.provider === 'string' ? value.provider : '',
      model: typeof value.model === 'string' ? value.model : '',
    }
  }

  async warmup(): Promise<Record<string, unknown>> {
    const value = await this.call('warmup', {})
    return value as Record<string, unknown>
  }

  /** Bypass cache (settings panel "re-detect"). */
  async refresh(): Promise<EngineStatusValue> {
    this.statusCache = undefined
    return this.status()
  }

  private async call(endpoint: string, payload: unknown): Promise<unknown> {
    const result = await this.rpc.call('/asr', endpoint, payload) as RpcResult
    if (!result || result.ok !== true) {
      throw new Error(result?.error?.message ?? `/${endpoint} failed`)
    }
    return result.value
  }
}
