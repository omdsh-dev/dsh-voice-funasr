import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineClient, EngineStatusValue } from './engine-client.ts'
import { loadPrefs, subscribePrefs, updatePrefs, type VoiceFunasrPrefs } from './prefs.ts'
import css from './SettingsPanel.module.css'

export type SettingsPanelProps = { engine: EngineClient } & PropsLocale<'voice.funasr'>

const LANG_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'zh-TW', label: '中文（繁体）' },
  { value: 'en-US', label: 'English (US)' },
]

export function SettingsPanel({ engine, t }: SettingsPanelProps) {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs)
  const [status, setStatus] = useState<EngineStatusValue | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [warming, setWarming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = (): void => {
    setDetecting(true)
    engine.refresh().then(
      value => { setStatus(value); setDetecting(false) },
      () => { setDetecting(false) },
    )
  }

  useEffect(() => {
    void engine.status().then(setStatus, () => {})
  }, [engine])

  const set = (patch: Partial<VoiceFunasrPrefs>): void => { updatePrefs(patch) }

  const warmup = (): void => {
    setWarming(true)
    engine.warmup().then(
      () => {
        setWarming(false)
        setNotice(t('engineWarmupDone'))
        refresh()
      },
      () => { setWarming(false) },
    )
  }

  const pythonOk = status?.python.found === true
  const modelsReady = status !== null && (status.missing ?? []).length === 0
  const engineReady = pythonOk && modelsReady

  return (
    <div className={css.section}>
      <div className={css.group}>
        <span className={css.groupTitle}>{t('engineGroupTitle')}</span>

        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>
              {status === null ? t('engineDetecting') : engineReady ? t('engineReady') : pythonOk ? t('engineModelsMissing', { missing: (status.missing ?? []).join(', ') }) : t('enginePythonMissing')}
            </span>
            {status !== null && (
              <span className={css.desc}>
                {status.python.found && status.python.version !== undefined ? `Python: ${status.python.version}` : ''}
                {status.python.found ? ` · ${t('engineProcess', { state: status.process })}` : ''}
              </span>
            )}
            {status?.lastError !== undefined && status.lastError !== '' && (
              <span className={css.desc}>{t('engineLastError', { error: status.lastError })}</span>
            )}
          </span>
          <span className={css.control}>
            <button type="button" className={css.action} disabled={detecting} onClick={refresh}>
              {t('engineDetectButton')}
            </button>
            <button type="button" className={css.action} disabled={warming || !pythonOk} onClick={warmup}>
              {t('engineWarmupButton')}
            </button>
          </span>
        </div>

        {!engineReady && (
          <div className={css.row}>
            <span className={css.rowText}>
              <span className={css.desc}>{t('engineInstallHint')} {status?.modelRoot ?? ''}</span>
            </span>
          </div>
        )}

        {notice !== null && <div className={css.notice}>{notice}</div>}
      </div>

      <div className={css.group}>
        <span className={css.groupTitle}>{t('inputGroupTitle')}</span>

        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('backendTitle')}</span>
          </span>
          <select
            className={css.select}
            value={prefs.backend}
            onChange={event => { set({ backend: event.currentTarget.value as VoiceFunasrPrefs['backend'] }) }}
          >
            <option value="auto">{t('backendAuto')}</option>
            <option value="funasr">{t('backendFunasr')}</option>
            <option value="webspeech">{t('backendWebSpeechOnly')}</option>
          </select>
        </div>

        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('langTitle')}</span>
          </span>
          <select
            className={css.select}
            value={prefs.lang}
            onChange={event => { set({ lang: event.currentTarget.value }) }}
          >
            {LANG_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={css.group}>
        <span className={css.groupTitle}>{t('polishGroupTitle')}</span>

        <label className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('polishEnabledTitle')}</span>
            <span className={css.desc}>{t('polishEnabledDesc')}</span>
          </span>
          <input
            type="checkbox"
            className={css.toggle}
            checked={prefs.polishEnabled}
            onChange={event => { set({ polishEnabled: event.currentTarget.checked }) }}
          />
        </label>

        {prefs.polishEnabled && (
          <div className={css.row}>
            <span className={css.rowText}>
              <span className={css.title}>{t('polishModeTitle')}</span>
            </span>
            <select
              className={css.select}
              value={prefs.polishMode}
              onChange={event => { set({ polishMode: event.currentTarget.value as VoiceFunasrPrefs['polishMode'] }) }}
            >
              <option value="polish">{t('polishModePolish')}</option>
              <option value="correct">{t('polishModeCorrect')}</option>
              <option value="format">{t('polishModeFormat')}</option>
            </select>
          </div>
        )}
      </div>

      <div className={css.group}>
        <span className={css.groupTitle}>{t('privacyTitle')}</span>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.desc}>{t('privacyDesc', { dir: status?.modelRoot ?? '' })}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
