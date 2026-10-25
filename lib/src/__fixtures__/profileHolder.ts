/**
 * Test-only B7 holder hosts on the REAL stack: a FakeWallet (the underlying
 * wallet) behind a wallet-toolbox `WalletPermissionsManager` with the real
 * `@bsv/color-permission-module` registered (`createColorModule`) and the
 * real Mandala issuer-v1 handler plus a host ledger, as a wallet host runs
 * them. An in-memory MessageBox bus connects holders.
 *
 * Every lib call a host runtime makes gets `wallet` (the manager, called with
 * the admin originator), `hostWallet` (the underlying FakeWallet), `ledger`
 * and `markSettled` (the module's in-process `markSettled`).
 *
 * The basename starts with `profile` because this file imports the color
 * module, which only the profile entry may do (coreIsolation.test.ts).
 */
import { Hash, PrivateKey, Utils, type WalletInterface } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { createColorModule, type ColorPermissionModule, type RequiredProfileHandler } from '@bsv/color-permission-module'
import { FakeWallet, memoryColorStore, withOriginator, type MemoryColorStore } from './fakeWallet.js'
import { createMandalaProfile } from '../profile.js'
import { createHostLedger, type HostLedger } from '../hostLedger.js'
import { memoryStorage, type MandalaStorage } from '../storage.js'
import { colorBasket } from '../naming.js'
import { decodeToken } from '../brc162.js'
import type { MessageBoxLike } from '../receive.js'
import type { MessageBoxSender } from '../receipt.js'

/** The host's admin originator (lib calls run as the wallet host itself). */
export const ADMIN = 'admin.test'

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

/** The #1338 suffix tag the module files every managed output with: `p color <sha256hex(utf8(suffix))>`. */
export function suffixTag (derivationSuffix: string): string {
  return `p color ${Utils.toHex(Hash.sha256(Utils.toArray(derivationSuffix, 'utf8')))}`
}

export interface ProfileHolder {
  fake: FakeWallet
  identityKey: string
  /** The permissions manager, called as ADMIN. */
  wallet: WalletInterface
  /** The underlying wallet. */
  hostWallet: WalletInterface
  ledger: HostLedger
  /** The real Mandala issuer-v1 handler registered on `color`. */
  handler: RequiredProfileHandler
  color: ColorPermissionModule
  store: MemoryColorStore
  markSettled: (txid: string) => Promise<void>
  /** This asset's value coins as the module's `p color assets` view shows them (`offline` = view tag `color_offline`). */
  coins: (assetId: string) => Promise<Array<{ outpoint: string, amount: bigint, offline: boolean }>>
}

export function makeProfileHolder (o: { K: string, url: string, fetch?: typeof fetch, priv?: PrivateKey, storage?: MandalaStorage }): ProfileHolder {
  const fake = new FakeWallet(o.priv ?? PrivateKey.fromRandom())
  const ledger = createHostLedger(o.storage ?? memoryStorage())
  const handler = createMandalaProfile({ overlays: [{ identityKey: o.K, url: o.url }], ledger, ...(o.fetch != null ? { fetch: o.fetch } : {}) })
  const store = memoryColorStore()
  const color = createColorModule({
    wallet: fake.asWallet(),
    // The handler's own Mandala provider: deploy resolution and routing hit the same object.
    provider: handler.deployProviders!()[0],
    requestTokenAccess: async () => true,
    store,
    profiles: { [handler.id]: handler }
  })
  const manager = new WalletPermissionsManager(fake.asWallet(), ADMIN, {
    permissionModules: { color },
    seekSpendingPermissions: false,
    encryptWalletMetadata: true
  })
  const wallet = withOriginator(manager as unknown as WalletInterface, ADMIN)
  const coins = async (assetId: string): Promise<Array<{ outpoint: string, amount: bigint, offline: boolean }>> => {
    const r = await wallet.listOutputs({ basket: 'p color assets', include: 'locking scripts', includeTags: true, limit: 10000 })
    const out: Array<{ outpoint: string, amount: bigint, offline: boolean }> = []
    for (const o of r.outputs) {
      const d = o.lockingScript != null ? decodeToken(o.lockingScript) : undefined
      if (d == null || d.assetId !== assetId || d.role !== 'value') continue
      out.push({ outpoint: o.outpoint, amount: d.amount, offline: (o.tags ?? []).includes('color_offline') })
    }
    return out.sort((a, b) => (a.outpoint < b.outpoint ? -1 : 1))
  }
  return {
    fake,
    identityKey: fake.identityKey,
    wallet,
    hostWallet: fake.asWallet(),
    ledger,
    handler,
    color,
    store,
    markSettled: async txid => { await color.markSettled(txid) },
    coins
  }
}

/** The exact bigint value `h` holds of `assetId` (unspent p color value outputs in the underlying wallet). */
export function heldAmount (h: ProfileHolder, assetId: string): bigint {
  let sum = 0n
  for (const o of h.fake.outputs.values()) {
    if (o.spent || o.basket !== colorBasket(assetId)) continue
    const d = decodeToken(o.tx.outputs[o.vout].lockingScript)
    if (d?.assetId === assetId && d.role === 'value') sum += d.amount
  }
  return sum
}
