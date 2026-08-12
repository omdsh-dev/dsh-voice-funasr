/**
 * dsh-voice-funasr — host half.
 *
 * Local offline FunASR voice input for the DSH Web UI. The host registers a
 * `/asr` RPC channel over the harness Connection transport (JSON POST) and
 * owns the Python engine sidecar (funasr-onnx, stdio line-JSON). Audio never
 * touches disk on the host: base64 PCM flows from the browser through the
 * engine's stdin; the engine deletes its temporary WAVs per request.
 *
 * Endpoints: status / transcribe / warmup / polish.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { EngineError, EngineManager, defaultModelRoot } from './engine/manager.ts'
import { polishText, type PolishRequest } from './engine/polish.ts'

export const name = 'dsh-voice-funasr'

export interface Config {
  /** Interpreter commands tried in order to launch the engine (default python3, python). */
  pythonCommands?: string[]
  /** Root dir containing paraformer/vad/punc model subdirs. */
  modelRoot?: string
  /** onnxruntime intra-op threads. */
  threads?: number
  /** Trust fence for the /asr channel ('loopback' default; 'trusted-host' for LAN). */
  channelAuthority?: 'loopback' | 'trusted-host'
  /** Max audio seconds accepted per transcribe request. */
  maxAudioSeconds?: number
}

export const Config: z<Config> = z.object({
  pythonCommands: z.array(z.string()).default(['python3', 'python']),
  modelRoot: z.string().default(''),
  threads: z.number().default(4),
  channelAuthority: z.union(['loopback', 'trusted-host']).default('loopback'),
  maxAudioSeconds: z.number().default(120),
})

export const inject = ['connection', 'subprocess', 'llm', 'agentDefaultModel'] as const

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-voice-funasr')
  const manager = new EngineManager(ctx, {
    pythonCommands: config.pythonCommands ?? ['python3', 'python'],
    modelRoot: config.modelRoot !== undefined && config.modelRoot !== '' ? config.modelRoot : defaultModelRoot(),
    threads: config.threads ?? 4,
  })

  ctx.effect(() => () => {
    void manager.dispose().catch(error => logger.warn(`engine dispose failed: ${String(error)}`))
  }, 'dsh-voice-funasr: engine lifecycle')

  ctx.effect(() => ctx.connection.rpc.handle('/asr', async (endpoint, payload, signal) => {
    try {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'request cancelled', details: {} } }
      }
      switch (endpoint) {
        case 'status': {
          const value = await manager.status()
          return { ok: true, value }
        }
        case 'transcribe': {
          const input = validateTranscribePayload(payload, config.maxAudioSeconds ?? 120)
          const value = await manager.transcribe(input)
          return { ok: true, value }
        }
        case 'warmup': {
          const value = await manager.warmup()
          return { ok: true, value }
        }
        case 'polish': {
          const input = validatePolishPayload(payload)
          const value = await polishText(ctx, input)
          return { ok: true, value }
        }
        default:
          return { ok: false, error: { code: 'internal', message: `unknown /asr endpoint: ${endpoint}`, details: {} } }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`/asr ${endpoint} failed: ${message}`)
      return { ok: false, error: { code: 'internal', message, details: {} } }
    }
  }, { authority: config.channelAuthority ?? 'loopback' }), 'dsh-voice-funasr: /asr channel')

  void manager.start().catch(() => {
    // startup probe failure is non-fatal; the engine still spawns lazily
    // on the first transcribe/warmup request
  })
}

function validateTranscribePayload(payload: unknown, maxAudioSeconds: number): {
  pcm16Base64: string
  sampleRate?: number
  vad?: boolean
  punc?: boolean
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new EngineError('bad-request', 'transcribe payload must be an object')
  }
  const record = payload as Record<string, unknown>
  const audio = record.audio
  if (typeof audio !== 'object' || audio === null) {
    throw new EngineError('bad-request', 'missing audio field')
  }
  const audioRecord = audio as Record<string, unknown>
  const pcm16Base64 = audioRecord.pcm16Base64
  if (typeof pcm16Base64 !== 'string' || pcm16Base64 === '') {
    throw new EngineError('bad-request', 'audio.pcm16Base64 must be a non-empty base64 string')
  }
  const sampleRate = typeof audioRecord.sampleRate === 'number' ? audioRecord.sampleRate : 16000
  const bytes = Math.floor(pcm16Base64.length * 0.75)
  const seconds = bytes / 2 / sampleRate
  if (seconds > maxAudioSeconds) {
    throw new EngineError('bad-request', `audio too long (${seconds.toFixed(1)}s > ${maxAudioSeconds}s)`)
  }
  return {
    pcm16Base64,
    sampleRate,
    vad: record.vad === undefined ? true : record.vad === true,
    punc: record.punc === undefined ? true : record.punc === true,
  }
}

function validatePolishPayload(payload: unknown): PolishRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new EngineError('bad-request', 'polish payload must be an object')
  }
  const record = payload as Record<string, unknown>
  const text = record.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new EngineError('bad-request', 'polish text must be a non-empty string')
  }
  const mode = record.mode
  return {
    text,
    mode: mode === 'correct' || mode === 'format' ? mode : 'polish',
  }
}
