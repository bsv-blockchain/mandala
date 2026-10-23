/**
 * Test-only B7 holder hosts: a FakeWallet (the underlying wallet) behind the
 * fake B7 color module (fakeB7Color.ts) with the real Mandala issuer-v1
 * handler and a host ledger, plus an in-memory MessageBox bus. Every lib call
 * a host runtime makes gets `wallet` (the module-fronted wallet), `hostWallet`
 * (the underlying FakeWallet), `ledger` and `markSettled`.
 */
import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { FakeWallet } from './fakeWallet.js'
import { fakeB7Color } from './fakeB7Color.js'
import { createMandalaProfile } from '../profile.js'
import { createHostLedger, type HostLedger } from '../hostLedger.js'
import { memoryStorage, type MandalaStorage } from '../storage.js'
import { colorBasket } from '../naming.js'
import { decodeToken } from '../brc162.js'
import type { MessageBoxLike } from '../receive.js'
import type { MessageBoxSender } from '../receipt.js'

export type Box = MessageBoxSender & MessageBoxLike

export function messageBus (): (identityKey: string) => Box {
  const boxes = new Map<string, Array<{ messageId: string, body: unknown, sender: string }>>()
  let n = 0
  return identityKey => ({
    sendMessage: async ({ recipient, messageBox, body }) => {
      const key = `${recipient}|${messageBox}`
      boxes.set(key, [...(boxes.get(key) ?? []), { messageId: `m${n++}`, body: JSON.parse(JSON.stringify(body)), sender: identityKey }])
      return { status: 'success' }
    },
    listMessages: async ({ messageBox }) => [...(boxes.get(`${identityKey}|${messageBox}`) ?? [])],
    acknowledgeMessage: async ({ messageIds }) => {
      for (const [key, list] of boxes) boxes.set(key, list.filter(m => !messageIds.includes(m.messageId)))
      return { status: 'success' }
    }
  })
}

export interface B7Holder {
  fake: FakeWallet
  identityKey: string
  wallet: WalletInterface
  hostWallet: WalletInterface
  ledger: HostLedger
  markSettled: (txid: string) => Promise<void>
  coins: (assetId: string) => Promise<Array<{ outpoint: string, amount: bigint, offline: boolean }>>
}

export function makeB7Holder (o: { K: string, url: string, fetch?: typeof fetch, priv?: PrivateKey, storage?: MandalaStorage }): B7Holder {
  const fake = new FakeWallet(o.priv ?? PrivateKey.fromRandom())
  const ledger = createHostLedger(o.storage ?? memoryStorage())
  const handler = createMandalaProfile({ overlays: [{ identityKey: o.K, url: o.url }], ledger, ...(o.fetch != null ? { fetch: o.fetch } : {}) })
  const color = fakeB7Color(fake, handler, o.K)
  return { fake, identityKey: fake.identityKey, wallet: color.wallet, hostWallet: fake.asWallet(), ledger, markSettled: color.markSettled, coins: color.coins }
}

/** The exact bigint value `h` holds of `assetId` (unspent p color value outputs). */
export function heldAmount (h: B7Holder, assetId: string): bigint {
  let sum = 0n
  for (const o of h.fake.outputs.values()) {
    if (o.spent || o.basket !== colorBasket(assetId)) continue
    const d = decodeToken(o.tx.outputs[o.vout].lockingScript)
    if (d?.assetId === assetId && d.role === 'value') sum += d.amount
  }
  return sum
}
