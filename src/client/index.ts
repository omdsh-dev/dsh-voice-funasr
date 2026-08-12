/**
 * dsh-voice-funasr — client half.
 *
 * Registers the mic button in the composer tool row and the settings panel.
 * The recognizer is backend-agnostic: local FunASR engine over the /asr RPC
 * channel, automatic Web Speech fallback when the engine is unavailable.
 */
import type { Context } from 'cordis'
import { RecorderButton } from './RecorderButton.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { EngineClient } from './engine-client.ts'
import { en, zh } from './locales.ts'

export const name = 'dsh-voice-funasr-client'

export const inject = ['slots', 'locale', 'connection']

export const LOCALE_NS = 'voice.funasr'

export function apply(ctx: Context): void {
  const engine = new EngineClient(ctx.connection.rpc)

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-voice-funasr: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS)

  ctx.effect(() => {
    return ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: 'voice-funasr-recorder',
      order: 10,
      locale: LOCALE_NS,
      inject: () => ({ engine }),
    }, RecorderButton))
  }, 'dsh-voice-funasr: recorder slot')

  ctx.effect(() => {
    return ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'voice-funasr-settings',
      order: 110,
      label: () => t('settingsTitle'),
      locale: LOCALE_NS,
      inject: () => ({ engine }),
    }, SettingsPanel))
  }, 'dsh-voice-funasr: settings slot')
}
