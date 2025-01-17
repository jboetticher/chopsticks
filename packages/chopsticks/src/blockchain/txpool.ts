import { EventEmitter } from 'node:stream'
import { HexString } from '@polkadot/util/types'
import _ from 'lodash'

import { Blockchain } from '.'
import { Deferred, defer } from '../utils'
import { InherentProvider } from './inherent'
import { buildBlock } from './block-builder'

export const APPLY_EXTRINSIC_ERROR = 'TxPool::ApplyExtrinsicError'

export enum BuildBlockMode {
  Batch, // one block per batch, default
  Instant, // one block per tx
  Manual, // only build when triggered
}

export interface DownwardMessage {
  sentAt: number
  msg: HexString
}

export interface HorizontalMessage {
  sentAt: number
  data: HexString
}

export interface BuildBlockParams {
  downwardMessages: DownwardMessage[]
  upwardMessages: Record<number, HexString[]>
  horizontalMessages: Record<number, HorizontalMessage[]>
  transactions: HexString[]
}

export class TxPool {
  readonly #chain: Blockchain

  readonly #pool: HexString[] = []
  readonly #ump: Record<number, HexString[]> = {}
  readonly #dmp: DownwardMessage[] = []
  readonly #hrmp: Record<number, HorizontalMessage[]> = {}

  readonly #mode: BuildBlockMode
  readonly #inherentProvider: InherentProvider
  readonly #pendingBlocks: { params: BuildBlockParams; deferred: Deferred<void> }[] = []

  readonly event = new EventEmitter()

  #isBuilding = false

  constructor(chain: Blockchain, inherentProvider: InherentProvider, mode: BuildBlockMode = BuildBlockMode.Batch) {
    this.#chain = chain
    this.#mode = mode
    this.#inherentProvider = inherentProvider
  }

  get pendingExtrinsics(): HexString[] {
    return this.#pool
  }

  submitExtrinsic(extrinsic: HexString) {
    this.#pool.push(extrinsic)

    this.#maybeBuildBlock()
  }

  submitUpwardMessages(id: number, ump: HexString[]) {
    if (!this.#ump[id]) {
      this.#ump[id] = []
    }
    this.#ump[id].push(...ump)

    this.#maybeBuildBlock()
  }

  submitDownwardMessages(dmp: DownwardMessage[]) {
    this.#dmp.push(...dmp)

    this.#maybeBuildBlock()
  }

  submitHorizontalMessages(id: number, hrmp: HorizontalMessage[]) {
    if (!this.#hrmp[id]) {
      this.#hrmp[id] = []
    }
    this.#hrmp[id].push(...hrmp)

    this.#maybeBuildBlock()
  }

  #maybeBuildBlock() {
    switch (this.#mode) {
      case BuildBlockMode.Batch:
        this.#batchBuildBlock()
        break
      case BuildBlockMode.Instant:
        this.buildBlock()
        break
      case BuildBlockMode.Manual:
        // does nothing
        break
    }
  }

  #batchBuildBlock = _.debounce(this.buildBlock, 100, { maxWait: 1000 })

  async buildBlockWithParams(params: BuildBlockParams) {
    this.#pendingBlocks.push({
      params,
      deferred: defer<void>(),
    })
    this.#buildBlockIfNeeded()
    await this.upcomingBlocks()
  }

  async buildBlock(params?: Partial<BuildBlockParams>) {
    const transactions = params?.transactions || this.#pool.splice(0)
    const upwardMessages = params?.upwardMessages || { ...this.#ump }
    const downwardMessages = params?.downwardMessages || this.#dmp.splice(0)
    const horizontalMessages = params?.horizontalMessages || { ...this.#hrmp }
    if (!params?.upwardMessages) {
      for (const id of Object.keys(this.#ump)) {
        delete this.#ump[id]
      }
    }
    if (!params?.horizontalMessages) {
      for (const id of Object.keys(this.#hrmp)) {
        delete this.#hrmp[id]
      }
    }
    await this.buildBlockWithParams({
      transactions,
      upwardMessages,
      downwardMessages,
      horizontalMessages,
    })
  }

  async upcomingBlocks() {
    const count = this.#pendingBlocks.length
    if (count > 0) {
      await this.#pendingBlocks[count - 1].deferred.promise
    }
    return count
  }

  async #buildBlockIfNeeded() {
    if (this.#isBuilding) return
    if (this.#pendingBlocks.length === 0) return

    this.#isBuilding = true
    try {
      await this.#buildBlock()
    } finally {
      this.#isBuilding = false
      this.#buildBlockIfNeeded()
    }
  }

  async #buildBlock() {
    await this.#chain.api.isReady

    const pending = this.#pendingBlocks[0]
    if (!pending) {
      throw new Error('Unreachable')
    }
    const { params, deferred } = pending

    const head = this.#chain.head
    const inherents = await this.#inherentProvider.createInherents(head, params)
    const [newBlock, pendingExtrinsics] = await buildBlock(
      head,
      inherents,
      params.transactions,
      params.upwardMessages,
      (extrinsic, error) => {
        this.event.emit(APPLY_EXTRINSIC_ERROR, [extrinsic, error])
      }
    )
    this.#pool.push(...pendingExtrinsics)
    await this.#chain.setHead(newBlock)

    this.#pendingBlocks.shift()
    deferred.resolve()
  }
}
