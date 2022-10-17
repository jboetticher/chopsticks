import { ApiPromise } from '@polkadot/api'

import { defaultLogger } from '../logger'
import State from '../state'

export const logger = defaultLogger.child({ name: 'rpc' })

export class ResponseError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.message = message
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
    }
  }
}

export interface Context {
  state: State
  api: ApiPromise
}

export type Handler = (
  context: Context,
  params: string[]
) => Promise<object | string | number | void | undefined | null>
export type Handlers = Record<string, Handler>