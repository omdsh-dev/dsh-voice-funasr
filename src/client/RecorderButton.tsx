import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createRecognizer,
  type RecognitionPhase,
  type SpeechRecognizer,
} from './asr.ts'
import { createFunasrRecognizer } from './backend-funasr.ts'
import { createWebSpeechRecognizer } from './backend-webspeech.ts'
import type { EngineClient } from './engine-client.ts'
import { loadPrefs, subscribePrefs } from './prefs.ts'
import css from './RecorderButton.module.css'

/** Composer input action surface (injected by the standard kit). */
export interface VoiceInputActions {
  setDraft(text: string): void
  submit(): void
}

export type RecorderButtonProps = {
  inputActions: VoiceInputActions
  engine: EngineClient
} & PropsLocale<'voice.funasr'>

type OverlayKind = 'recording' | 'transcribing' | 'polishing' | 'interim' | 'error' | null

/** Engine error codes → localized hints (raw code stays visible in details). */
function isEngineFailure(code: string): boolean {
  return code.startsWith('engine-') || code === 'audio-capture'
}

export function RecorderButton({ inputActions, engine, t }: RecorderButtonProps) {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs)
  const [phase, setPhase] = useState<RecognitionPhase>('idle')
  const [overlay, setOverlay] = useState<{ kind: OverlayKind; text: string }>({ kind: null, text: '' })
  const [engineBadge, setEngineBadge] = useState<'ok' | 'failed' | 'unknown'>('unknown')

  const pressedRef = useRef(false)
  const recognizerRef = useRef<SpeechRecognizer | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const inputActionsRef = useRef(inputActions)
  inputActionsRef.current = inputActions
  const tRef = useRef(t)
  tRef.current = t
  const overlayRef = useRef<{ kind: OverlayKind; text: string }>({ kind: null, text: '' })
  overlayRef.current = overlay

  // engine health probe (for the badge and fallback messaging)
  useEffect(() => {
    let alive = true
    void engine.probeEngine().then(snapshot => {
      if (!alive) return
      setEngineBadge(snapshot.available ? 'ok' : 'failed')
    })
    return () => { alive = false }
  }, [engine])

  // (re)build the recognizer when the backend preference or language changes
  useEffect(() => {
    let alive = true
    let recognizer: SpeechRecognizer | null = null
    void createRecognizer(
      {
        probeEngine: () => engine.probeEngine(),
        createFunasrRecognizer: (options, hooks) => createFunasrRecognizer(engine, options, hooks),
        createWebSpeechRecognizer,
      },
      prefs.backend,
      { lang: prefs.lang },
      {
        onStart: () => {
          setPhase('recording')
          setOverlay({ kind: 'recording', text: tRef.current('recording') })
        },
        onInterim: (text) => {
          setOverlay({ kind: 'interim', text })
        },
        onResult: (text) => {
          if (pressedRef.current) return // silent-end while still held: onEnd restarts
          setOverlay({ kind: null, text: '' })
          if (text === '') return
          deliver(text)
        },
        onError: (error) => {
          const hint = messageOf(error.code, tRef.current)
          setOverlay({ kind: 'error', text: hint })
          if (isEngineFailure(error.code)) setEngineBadge('failed')
        },
        onEnd: () => {
          setPhase('idle')
          if (overlayRef.current.kind !== 'error' && overlayRef.current.kind !== 'polishing') {
            setOverlay({ kind: null, text: '' })
          }
          if (pressedRef.current) recognizer?.start()
        },
      },
    ).then(({ recognizer: created }) => {
      if (!alive) {
        created.dispose()
        return
      }
      recognizer = created
      recognizerRef.current = created
    })
    return () => {
      alive = false
      recognizer?.dispose()
      recognizerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.backend, prefs.lang, engine])

  /** Send final text: polish first when enabled (raw text on failure). */
  const deliver = (text: string): void => {
    const current = prefsRef.current
    if (!current.polishEnabled) {
      inputActionsRef.current.setDraft(text)
      inputActionsRef.current.submit()
      return
    }
    setOverlay({ kind: 'polishing', text: t('polishing') })
    engine.polish(text, current.polishMode).then(
      result => {
        setOverlay({ kind: null, text: '' })
        inputActionsRef.current.setDraft(result.text)
        inputActionsRef.current.submit()
      },
      () => {
        setOverlay({ kind: null, text: '' })
        inputActionsRef.current.setDraft(text)
        inputActionsRef.current.submit()
      },
    )
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pressedRef.current = true
    setOverlay({ kind: null, text: '' })
    recognizerRef.current?.start()
  }

  const handlePointerEnd = (): void => {
    if (!pressedRef.current) return
    pressedRef.current = false
    recognizerRef.current?.stop()
  }

  const recording = phase === 'recording'
  const pending = phase === 'stopping'

  return (
    <div className={css.wrap}>
      {(overlay.kind !== null) && (
        <div
          className={overlay.kind === 'error' ? css.overlayError : css.overlay}
          role={overlay.kind === 'error' ? 'alert' : 'status'}
        >
          {overlay.text}
        </div>
      )}
      <button
        type="button"
        className={recording || pending ? css.micActive : css.mic}
        aria-label={t('buttonLabel')}
        aria-pressed={recording}
        title={t('holdToTalk')}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <svg className={css.icon} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z"
          />
        </svg>
        {prefs.showEngineBadge && (
          <span
            className={engineBadge === 'ok' ? css.dotOk : engineBadge === 'failed' ? css.dotFailed : css.dotUnknown}
            title={engineBadge === 'ok' ? t('backendLocal') : engineBadge === 'failed' ? t('engineMissing') : t('engineDetecting')}
          />
        )}
      </button>
    </div>
  )
}

function messageOf(code: string, t: RecorderButtonProps['t']): string {
  switch (code) {
    case 'unsupported': return t('unsupported')
    case 'not-allowed':
    case 'service-not-allowed': return t('notAllowed')
    case 'network': return t('network')
    case 'no-speech': return t('noSpeech')
    case 'audio-capture': return t('audioCapture')
    case 'engine-unavailable':
    case 'engine-crashed':
    case 'engine-stopped':
    case 'engine-error':
    case 'engine-response': return t('engineUnavailable')
    case 'engine-python-missing':
    case 'engine-models-missing':
    case 'engine-spawn': return t('engineMissing')
    case 'engine-timeout': return t('engineTimeout')
    default: return t('failure', { code })
  }
}

// re-export for tests
export { messageOf }
