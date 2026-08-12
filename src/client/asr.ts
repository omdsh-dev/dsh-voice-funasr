/**
 * ASR adapter layer: voice → text, backend-agnostic.
 *
 * Two backends implement the same SpeechRecognizer contract:
 *  - funasr backend: AudioWorklet capture → /asr RPC → local engine
 *  - webspeech backend: Web Speech API (automatic fallback)
 *
 * The factory picks the backend at creation time (engine status probe +
 * user preference) and transparently falls back to Web Speech when the
 * local engine is unavailable.
 */

export type RecognitionPhase = 'idle' | 'recording' | 'stopping'

export interface RecognitionError {
  readonly code: string
  readonly message: string
}

export interface RecognitionHooks {
  onStart?: () => void
  /** Real-time intermediate text (v1 local backend emits none; v2 2pass will). */
  onInterim?: (text: string) => void
  /** Final text delivered once per session (may be empty). */
  onResult?: (text: string) => void
  onError?: (error: RecognitionError) => void
  /** Always fires after a session ends, with or without a result. */
  onEnd?: () => void
}

export interface RecognizerOptions {
  /** BCP-47 language for the Web Speech backend (local backend is zh-only in v1). */
  lang: string
}

export interface SpeechRecognizer {
  readonly phase: RecognitionPhase
  start(): void
  stop(): void
  abort(): void
  dispose(): void
}

/** Backend chosen by the factory. */
export type AsrBackend = 'funasr' | 'webspeech'

export interface EngineSnapshot {
  available: boolean
  pythonFound: boolean
  modelsMissing: string[]
  process: string
}

export interface AsrDeps {
  /**
   * Engine availability probe. Called once at factory creation and cached
   * by the caller; must never throw.
   */
  probeEngine(): Promise<EngineSnapshot>
  /** Create the local-engine recognizer (capture + /asr RPC). */
  createFunasrRecognizer(options: RecognizerOptions, hooks: RecognitionHooks): SpeechRecognizer
  /** Create the Web Speech recognizer. */
  createWebSpeechRecognizer(options: RecognizerOptions, hooks: RecognitionHooks): SpeechRecognizer
}

export type BackendPreference = 'auto' | 'funasr' | 'webspeech'

/**
 * Pick a recognizer for the given preference and engine snapshot. Never
 * returns a dead local recognizer: preference 'funasr' with an unavailable
 * engine falls back to Web Speech (the contract in the README).
 */
export async function createRecognizer(
  deps: AsrDeps,
  preference: BackendPreference,
  options: RecognizerOptions,
  hooks: RecognitionHooks,
): Promise<{ recognizer: SpeechRecognizer; backend: AsrBackend }> {
  const snapshot = await deps.probeEngine()
  if (preference === 'webspeech') {
    return { recognizer: deps.createWebSpeechRecognizer(options, hooks), backend: 'webspeech' }
  }
  if (snapshot.available || preference === 'funasr') {
    return { recognizer: deps.createFunasrRecognizer(options, hooks), backend: 'funasr' }
  }
  return { recognizer: deps.createWebSpeechRecognizer(options, hooks), backend: 'webspeech' }
}
