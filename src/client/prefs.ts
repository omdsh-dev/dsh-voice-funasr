/**
 * Client preferences (localStorage, same pattern as other DSH web plugins).
 */

import type { BackendPreference } from './asr.ts'
import type { PolishMode } from './polish.ts'

export interface VoiceFunasrPrefs {
  /** ASR backend preference: auto / funasr / webspeech. */
  backend: BackendPreference
  /** BCP-47 language (Web Speech backend; local backend is zh in v1). */
  lang: string
  /** LLM polish after transcription (two-stage engine). */
  polishEnabled: boolean
  /** Polish mode. */
  polishMode: PolishMode
  /** Show the engine-status dot on the mic button. */
  showEngineBadge: boolean
}

export const DEFAULT_PREFS: VoiceFunasrPrefs = {
  backend: 'auto',
  lang: 'zh-CN',
  polishEnabled: true,
  polishMode: 'polish',
  showEngineBadge: true,
}

export const PREFS_KEY = 'dsh-voice-funasr.prefs'

function mergePrefs(raw: unknown): VoiceFunasrPrefs {
  const input = (raw ?? {}) as Partial<VoiceFunasrPrefs>
  return {
    backend: input.backend === 'funasr' || input.backend === 'webspeech' ? input.backend : DEFAULT_PREFS.backend,
    lang: typeof input.lang === 'string' && input.lang !== '' ? input.lang : DEFAULT_PREFS.lang,
    polishEnabled: typeof input.polishEnabled === 'boolean' ? input.polishEnabled : DEFAULT_PREFS.polishEnabled,
    polishMode: input.polishMode === 'correct' || input.polishMode === 'format' ? input.polishMode : DEFAULT_PREFS.polishMode,
    showEngineBadge: typeof input.showEngineBadge === 'boolean' ? input.showEngineBadge : DEFAULT_PREFS.showEngineBadge,
  }
}

function storage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined
  } catch {
    return undefined
  }
}

let memoryCache: VoiceFunasrPrefs | null = null

export function loadPrefs(): VoiceFunasrPrefs {
  // Cache the first resolved snapshot. loadPrefs is passed as the getSnapshot
  // of useSyncExternalStore, which requires a stable reference between
  // store changes; returning a fresh object on every call makes React treat
  // the store as perpetually dirty and the component re-renders forever
  // until it crashes (caught by the slot error boundary, hiding the button).
  if (memoryCache !== null) return memoryCache
  const store = storage()
  if (store !== undefined) {
    try {
      const raw = store.getItem(PREFS_KEY)
      if (raw !== null) {
        memoryCache = mergePrefs(JSON.parse(raw) as unknown)
        return memoryCache
      }
    } catch {
      // fall through to cache/default
    }
  }
  memoryCache = { ...DEFAULT_PREFS }
  return memoryCache
}

export function updatePrefs(patch: Partial<VoiceFunasrPrefs>): VoiceFunasrPrefs {
  const next = mergePrefs({ ...loadPrefs(), ...patch })
  memoryCache = next
  const store = storage()
  if (store !== undefined) {
    try {
      store.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      // storage full / private mode: keep in-memory only
    }
  }
  notifyPrefsChanged()
  return next
}

const listeners = new Set<() => void>()

export function subscribePrefs(callback: () => void): () => void {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

export function notifyPrefsChanged(): void {
  for (const listener of [...listeners]) listener()
}
