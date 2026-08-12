/**
 * Local-engine recognizer: AudioWorklet capture → /asr/transcribe RPC.
 *
 * v1 is whole-utterance: start() begins capture, stop() sends the full
 * buffer and delivers the final text once (no interim). The engine-side
 * pipeline is VAD + paraformer + ct-punc (all int8 onnx).
 */

import type { RecognitionHooks, RecognizerOptions, SpeechRecognizer, RecognitionPhase } from './asr.ts'
import { createPcm16Capture, isCaptureSupported, type Pcm16Capture } from './capture.ts'

export interface AsrChannel {
  transcribe(payload: { pcm16Base64: string; sampleRate: number; vad?: boolean; punc?: boolean }): Promise<{
    text: string
    rawText: string
    durationS: number
    elapsedMs: number
  }>
}

export function createFunasrRecognizer(
  channel: AsrChannel,
  _options: RecognizerOptions,
  hooks: RecognitionHooks,
): SpeechRecognizer {
  const unsupported: SpeechRecognizer = {
    phase: 'idle',
    start(): void { hooks.onError?.({ code: 'unsupported', message: 'AudioWorklet capture unavailable' }) },
    stop(): void {},
    abort(): void {},
    dispose(): void {},
  }
  if (!isCaptureSupported()) return unsupported

  let phase: RecognitionPhase = 'idle'
  let capture: Pcm16Capture | undefined
  let stopped = false
  let disposed = false

  const fail = (code: string, message: string): void => {
    if (disposed) return
    phase = 'idle'
    hooks.onError?.({ code, message })
    hooks.onEnd?.()
  }

  return {
    get phase(): RecognitionPhase { return phase },

    start(): void {
      if (phase !== 'idle' || disposed) return
      stopped = false
      capture = createPcm16Capture()
      capture.start().then(() => {
        if (stopped || disposed) return
        phase = 'recording'
        hooks.onStart?.()
      }, (error: unknown) => {
        fail('audio-capture', error instanceof Error ? error.message : String(error))
      })
    },

    stop(): void {
      if (phase !== 'recording' || capture === undefined) return
      phase = 'stopping'
      stopped = true
      const active = capture
      capture = undefined
      active.stop().then(async ({ pcm16Base64, sampleRate, durationS }) => {
        if (disposed) return
        if (durationS < 0.2) {
          phase = 'idle'
          hooks.onResult?.('')
          hooks.onEnd?.()
          return
        }
        try {
          const result = await channel.transcribe({ pcm16Base64, sampleRate })
          if (disposed) return
          phase = 'idle'
          hooks.onResult?.(result.text)
          hooks.onEnd?.()
        } catch (error) {
          fail('engine-unavailable', error instanceof Error ? error.message : String(error))
        }
      }, (error: unknown) => {
        fail('audio-capture', error instanceof Error ? error.message : String(error))
      })
    },

    abort(): void {
      if (phase === 'idle') return
      phase = 'idle'
      stopped = true
      capture?.dispose()
      capture = undefined
      hooks.onEnd?.()
    },

    dispose(): void {
      disposed = true
      phase = 'idle'
      capture?.dispose()
      capture = undefined
    },
  }
}
