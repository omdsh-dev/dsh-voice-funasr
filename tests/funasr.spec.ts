import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRecognizer } from '../src/client/asr.ts'
import type { AsrDeps, RecognitionHooks, SpeechRecognizer } from '../src/client/asr.ts'
import { EngineClient } from '../src/client/engine-client.ts'
import { loadPrefs, updatePrefs } from '../src/client/prefs.ts'
import { messageOf } from '../src/client/RecorderButton.tsx'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh?: { client?: { inject?: string[]; platform?: string }; bundle?: { patch?: string } }
  dshClient?: unknown
  files?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

describe('DSH 0.1.0-rc.3 package contract', () => {
  it('uses nested client metadata and the Profile Bundle patch', () => {
    expect(packageJson.dshClient).toBeUndefined()
    expect(packageJson.dsh?.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-settings',
      ],
      platform: 'web',
    })
    expect(packageJson.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(packageJson.files).toContain('lib/**/*.js')
    expect(Object.keys(packageJson.peerDependencies ?? {})).toEqual(
      Object.keys(packageJson.peerDependenciesMeta ?? {}),
    )
    expect(Object.values(packageJson.peerDependenciesMeta ?? {}).every(meta => meta.optional === true)).toBe(true)
    const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [, range] of dshPeers) expect(range).toBe('>=0.1.0-rc.3 <0.2.0')
  })
})

const fakeRecognizer = (): SpeechRecognizer => ({
  phase: 'idle',
  start(): void {},
  stop(): void {},
  abort(): void {},
  dispose(): void {},
})

function makeDeps(available: boolean): AsrDeps {
  return {
    probeEngine: vi.fn(async () => ({
      available,
      pythonFound: available,
      modelsMissing: available ? [] : ['asr', 'vad', 'punc'],
      process: 'stopped',
    })),
    createFunasrRecognizer: () => fakeRecognizer(),
    createWebSpeechRecognizer: () => fakeRecognizer(),
  }
}

const hooks: RecognitionHooks = {}

describe('createRecognizer backend selection', () => {
  it('prefers local engine when available under auto', async () => {
    const { backend } = await createRecognizer(makeDeps(true), 'auto', { lang: 'zh-CN' }, hooks)
    expect(backend).toBe('funasr')
  })

  it('falls back to webspeech when the engine is unavailable', async () => {
    const { backend } = await createRecognizer(makeDeps(false), 'auto', { lang: 'zh-CN' }, hooks)
    expect(backend).toBe('webspeech')
  })

  it('forces local engine under explicit funasr preference', async () => {
    const { backend } = await createRecognizer(makeDeps(false), 'funasr', { lang: 'zh-CN' }, hooks)
    expect(backend).toBe('funasr')
  })

  it('forces webspeech under explicit preference', async () => {
    const { backend } = await createRecognizer(makeDeps(true), 'webspeech', { lang: 'zh-CN' }, hooks)
    expect(backend).toBe('webspeech')
  })
})

describe('prefs', () => {
  it('clamps unknown values to defaults', () => {
    updatePrefs({ backend: 'bogus' as never, polishMode: 'nope' as never })
    const prefs = loadPrefs()
    expect(prefs.backend).toBe('auto')
    expect(prefs.polishMode).toBe('polish')
    expect(prefs.lang).toBe('zh-CN')
    updatePrefs({}) // reset for other tests
  })

  it('keeps valid values', () => {
    updatePrefs({ backend: 'funasr', polishMode: 'format', lang: 'en-US' })
    const prefs = loadPrefs()
    expect(prefs.backend).toBe('funasr')
    expect(prefs.polishMode).toBe('format')
    expect(prefs.lang).toBe('en-US')
    updatePrefs({})
  })
})

describe('engine client envelope unwrap', () => {
  it('unwraps ok results', async () => {
    const client = new EngineClient({
      call: vi.fn(async () => ({ ok: true, value: { text: '你好。', rawText: '你好' } })),
    })
    const result = await client.transcribe({ pcm16Base64: 'AAAA', sampleRate: 16000 })
    expect(result.text).toBe('你好。')
  })

  it('throws the server message on failure', async () => {
    const client = new EngineClient({
      call: vi.fn(async () => ({ ok: false, error: { code: 'internal', message: 'python not found' } })),
    })
    await expect(client.transcribe({ pcm16Base64: 'AAAA', sampleRate: 16000 }))
      .rejects.toThrow('python not found')
  })
})

describe('messageOf', () => {
  const t = (key: string): string => key

  it('maps engine codes to fallback hints', () => {
    expect(messageOf('engine-python-missing', t)).toBe('engineMissing')
    expect(messageOf('engine-timeout', t)).toBe('engineTimeout')
    expect(messageOf('engine-crashed', t)).toBe('engineUnavailable')
  })

  it('passes unknown codes through', () => {
    expect(messageOf('weird-code', t)).toBe('failure')
  })
})
