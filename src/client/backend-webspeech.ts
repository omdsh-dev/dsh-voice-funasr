/**
 * Web Speech recognizer — automatic fallback when the local engine is
 * unavailable (python missing, models missing, capture unsupported).
 * Fresh implementation: interim results, final accumulation, abort
 * semantics, and a safe no-op recognizer for unsupported browsers.
 */

import type { RecognitionHooks, RecognizerOptions, SpeechRecognizer, RecognitionPhase } from './asr.ts'

export function isWebSpeechSupported(): boolean {
  return typeof window !== 'undefined' && window.webkitSpeechRecognition !== undefined
}

export function createWebSpeechRecognizer(
  options: RecognizerOptions,
  hooks: RecognitionHooks,
): SpeechRecognizer {
  const ctor = typeof window !== 'undefined' ? window.webkitSpeechRecognition : undefined
  if (ctor === undefined) {
    let phase: RecognitionPhase = 'idle'
    return {
      get phase(): RecognitionPhase { return phase },
      start(): void {
        phase = 'idle'
        hooks.onError?.({ code: 'unsupported', message: 'This browser does not support the Web Speech API' })
        hooks.onEnd?.()
      },
      stop(): void {},
      abort(): void { phase = 'idle' },
      dispose(): void { phase = 'idle' },
    }
  }

  let phase: RecognitionPhase = 'idle'
  let recognition: WebkitSpeechRecognition | undefined
  let finalText = ''
  let aborting = false

  const onEnd = (): void => {
    if (phase === 'idle') return
    phase = 'idle'
    hooks.onEnd?.()
  }

  const ensure = (): WebkitSpeechRecognition => {
    if (recognition === undefined) {
      recognition = new ctor()
      recognition.lang = options.lang
      recognition.continuous = false
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      recognition.onstart = () => { hooks.onStart?.() }
      recognition.onresult = (event: WebkitSpeechRecognitionEvent) => {
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i]
          if (result === undefined) continue
          const transcript = result[0]?.transcript ?? ''
          if (result.isFinal) {
            if (transcript !== '') finalText += transcript
          } else {
            interim += transcript
          }
        }
        if (interim !== '') hooks.onInterim?.(interim)
      }
      recognition.onerror = (event: WebkitSpeechRecognitionErrorEvent) => {
        if (event.error === 'aborted' || event.error === 'no-speech') return
        hooks.onError?.({ code: event.error, message: event.message })
      }
      recognition.onend = () => {
        recognition = undefined
        if (aborting) {
          aborting = false
          finalText = ''
          onEnd()
          return
        }
        const text = finalText
        finalText = ''
        hooks.onResult?.(text)
        onEnd()
      }
    }
    return recognition
  }

  return {
    get phase(): RecognitionPhase { return phase },

    start(): void {
      if (phase === 'recording') return
      finalText = ''
      aborting = false
      phase = 'recording'
      try {
        ensure().start()
      } catch {
        phase = 'idle'
      }
    },

    stop(): void {
      if (phase !== 'recording') return
      phase = 'stopping'
      try {
        recognition?.stop()
      } catch {
        onEnd()
      }
    },

    abort(): void {
      if (phase === 'idle') return
      phase = 'idle'
      aborting = true
      try {
        recognition?.abort()
      } catch {
        aborting = false
        onEnd()
      }
    },

    dispose(): void {
      if (recognition !== undefined) {
        recognition.onstart = null
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        try {
          if (phase !== 'idle') recognition.abort()
        } catch {
          // ignore
        }
        recognition = undefined
      }
      phase = 'idle'
    },
  }
}
