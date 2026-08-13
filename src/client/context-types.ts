/** DSH 0.1.0-rc.3 client contracts consumed by the browser half. */
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'voice.funasr': keyof typeof zh
  }
}

export type RpcChannelCall = ClientConnectionRpc
export type Context = ClientContext
