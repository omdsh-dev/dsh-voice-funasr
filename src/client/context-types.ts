/** Structural mirrors of the services the client plugin injects. */
import type { Context } from 'cordis'
import type { zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'voice.funasr': keyof typeof zh
  }
}

export interface SlotRegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  select?: (owner: unknown) => unknown
  locale?: string
  inject?: () => Record<string, unknown>
}

/** ctx.slots.register returns the slot disposer; inject(key, cb) returns a disposer. */
export interface SlotsService {
  register(options: SlotRegisterOptions, component: unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

/** ctx.locale.register returns the dictionary disposer. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

export interface RpcChannelCall {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

declare module 'cordis' {
  interface Context {
    slots: SlotsService
    locale: LocaleService
    connection: { rpc: RpcChannelCall }
  }
}

export type { Context }
