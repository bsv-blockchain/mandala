/**
 * Test-only stand-in for `@bsv/color-permission-module` after the B7 rework,
 * limited to what the Mandala issuer-v1 handler and the lib's holder paths
 * exercise (design §9 B7). It is NOT the module: it exists so lib tests can
 * run the B7 handler interface end to end until the B7 module tarball is
 * vendored. Re-verify every behaviour pinned with it against the real module.
 *
 * What it does, over a FakeWallet (the "underlying wallet"):
 * - `internalizeAction` into `p color <assetTag>`: the receipt must be plain
 *   BRC-207 custody JSON (exactly 5 members, profileData rejected, < 1000
 *   bytes); the handler's `admitReceipt(ctx, {assetId, txid, outputIndex, tx,
 *   beef})` decides; a throw is no credit; `pending` tags the output
 *   `color_offline`.
 * - a plain-noSend hand-over: `createAction` with plan labels selects this
 *   wallet's `p color` coins of the asset, adds token change to self (fresh
 *   remittances, custody set), runs `checkPlanData` and, at `signAction`,
 *   `checkPlanData` again (B7: `submissionData` is NOT called for a plain
 *   hand-over), checks every token input with the asset provider's
 *   `spendability()` at createAction and again at signAction (refusing an
 *   unlisted input), then signs the token inputs with their BRC-42 `p color`
 *   keys. Custody of kept outputs is stored encrypted under the toolbox
 *   metadata key, like the manager does. The change is tagged
 *   `color_offline`. Nothing is submitted.
 * - `markSettled(txid)`: clears `color_offline` on that tx's outputs.
 */
import { P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import type { FakeWallet } from './fakeWallet.js'
import type { B7RequiredProfileHandler } from '../profileTypes.js'
import { MANDALA_PROFILE_ID } from '../constants.js'
import { assetTag, colorBasket, colorProtocolID } from '../naming.js'
import { decodeToken } from '../brc162.js'
import { outputPubKeyHash } from '../blinding.js'
import { PLAN_LABEL_PREFIX } from '../plan.js'

const RECEIPT_KEYS = ['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey']

interface Custody { assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string }

function decodePlan (labels: string[]): any {
  const parts = labels.filter(l => l.startsWith(PLAN_LABEL_PREFIX + ' ')).map(l => l.split(' '))
    .map(p => ({ i: Number(p[3]), hex: p[5] })).sort((x, y) => x.i - y.i)
  if (parts.length === 0) return undefined
  return JSON.parse(Utils.toUTF8(Utils.toArray(parts.map(p => p.hex).join(''), 'hex')))
}

export interface FakeB7Color {
  wallet: WalletInterface
  markSettled: (txid: string) => Promise<void>
  /** Outpoints of this asset's p color coins and whether each is tagged color_offline. */
  coins: (assetId: string) => Promise<Array<{ outpoint: string, amount: bigint, offline: boolean }>>
}

const META: [2, 'admin metadata encryption'] = [2, 'admin metadata encryption']

export function fakeB7Color (fake: FakeWallet, handler: B7RequiredProfileHandler, K: string): FakeB7Color {
  const descriptor = { version: 1, params: { identityKey: K } }
  const ctxFor = (assetId: string): any => ({
    assetId,
    profileId: MANDALA_PROFILE_ID,
    descriptor,
    req: new Map([[MANDALA_PROFILE_ID, descriptor]]),
    declarationTx: undefined,
    wallet: fake.asWallet(),
    identityKey: fake.identityKey,
    originator: 'admin.test'
  })
  const pending = new Map<string, { assetId: string, plan: any, inputs: Array<{ outpoint: string, custody: Custody, amount: bigint }>, change?: { custody: Custody, index: number }, requested: number }>()

  const seal = async (c: Custody): Promise<string> =>
    Utils.toBase64((await fake.proto.encrypt({ plaintext: Utils.toArray(JSON.stringify({ version: 1, ...c }), 'utf8'), protocolID: META, keyID: '1' })).ciphertext)
  const open = async (v: string): Promise<Custody> => {
    try {
      return JSON.parse(Utils.toUTF8((await fake.proto.decrypt({ ciphertext: Utils.toArray(v, 'base64'), protocolID: META, keyID: '1' })).plaintext))
    } catch {
      return JSON.parse(v)
    }
  }
  const coins = async (assetId: string): Promise<Array<{ outpoint: string, amount: bigint, offline: boolean, custody: Custody }>> => {
    const out: Array<{ outpoint: string, amount: bigint, offline: boolean, custody: Custody }> = []
    for (const [outpoint, o] of fake.outputs) {
      if (o.spent || o.reservedBy != null || o.basket !== colorBasket(assetId) || o.customInstructions == null) continue
      const d = decodeToken(o.tx.outputs[o.vout].lockingScript)
      if (d == null || d.role !== 'value') continue
      out.push({ outpoint, amount: d.amount, offline: o.tags.includes('color_offline'), custody: await open(o.customInstructions) })
    }
    return out.sort((a, b) => (a.outpoint < b.outpoint ? -1 : 1))
  }
  /** The module's input check: every token input must be listed by the asset provider's spendability. */
  const checkSpendable = async (assetId: string, outpoints: string[]): Promise<void> => {
    if (outpoints.length === 0) return
    const provider = handler.provider!(assetId, descriptor as any)
    const answer: any = await provider.spendability(assetId, outpoints)
    const listed = new Set((answer?.outputs ?? []).map((o: any) => `${String(o.txid)}.${String(o.outputIndex)}`))
    const missing = outpoints.filter(o => !listed.has(o))
    if (missing.length > 0) throw new Error(`BRC-207: token input ${missing[0]} is not spendable`)
  }

  const viewOf = (assetId: string, tx: Transaction | undefined, p: { inputs: Array<{ outpoint: string, custody: Custody, amount: bigint }>, requested: number, change?: { custody: Custody, index: number } }, planLeaf: unknown, outputs: Array<{ index: number, amount: bigint }>): any => ({
    ...(tx != null ? { tx } : {}),
    assetId,
    inputs: p.inputs.map((c, i) => ({ inputIndex: i, outpoint: c.outpoint, role: 'value', amount: c.amount, custody: c.custody })),
    outputs: outputs.map(o => ({
      outputIndex: o.index,
      role: 'value',
      amount: o.amount,
      ...(p.change != null && p.change.index === o.index ? { custody: p.change.custody } : {})
    })),
    ...(planLeaf !== undefined ? { planLeaf } : {})
  })

  const wallet = new Proxy(fake as any, {
    get (target, prop, receiver) {
      if (prop === 'internalizeAction') {
        return async (args: any) => {
          const tx = Transaction.fromAtomicBEEF(args.tx)
          const txid = tx.id('hex')
          for (const output of args.outputs) {
            const r = output.insertionRemittance
            if (output.protocol !== 'basket insertion' || r == null || !String(r.basket).startsWith('p color ')) {
              throw new Error('fakeB7Color: only p color basket insertions are modelled')
            }
            if (Utils.toArray(r.customInstructions, 'utf8').length >= 1000) throw new Error('fakeB7Color: receipt over 1000 bytes')
            const receipt = JSON.parse(r.customInstructions)
            const keys = Object.keys(receipt)
            if (keys.length !== 5 || !RECEIPT_KEYS.every(k => keys.includes(k))) throw new Error('[ProfileDataError] receipt must be plain BRC-207 custody JSON')
            if (r.basket !== `p color ${assetTag(receipt.assetId)}`) throw new Error('fakeB7Color: basket does not match the receipt asset')
            const credit = await handler.admitReceipt(ctxFor(receipt.assetId), { assetId: receipt.assetId, txid, outputIndex: output.outputIndex, tx, beef: args.tx })
            fake.store(tx, output.outputIndex, r.basket, r.customInstructions, credit.credit === 'pending' ? ['color_offline'] : [])
          }
          return { accepted: true }
        }
      }
      if (prop === 'createAction') {
        return async (args: any) => {
          const plan = decodePlan(args.labels ?? [])
          if (plan == null || args.options?.sendWith != null) return await target.createAction(args)
          if (args.options?.noSend !== true) throw new Error('fakeB7Color: plain-nosend requires noSend')
          const assetId: string = plan.assets[0]
          const outputs = (args.outputs ?? []).map((o: any, index: number) => ({ index, o, d: decodeToken(o.lockingScript) }))
          const need = outputs.reduce((s: bigint, x: any) => s + (x.d?.amount ?? 0n), 0n)
          const ownedIdx = new Set((plan.ownedOutputs ?? []).map((o: any) => o.outputIndex))
          const leaf = plan.profileData?.[MANDALA_PROFILE_ID]?.[assetId]
          let have = 0n
          const picked: Array<{ outpoint: string, custody: Custody, amount: bigint }> = []
          for (const c of await coins(assetId)) {
            if (have >= need) break
            picked.push(c)
            have += c.amount
          }
          if (have < need) throw new Error('fakeB7Color: insufficient tokens')
          const change = have - need
          const outs = [...args.outputs]
          let changeInfo: { custody: Custody, index: number } | undefined
          if (change > 0n) {
            const custody: Custody = { assetId, derivationPrefix: Utils.toBase64([outs.length, 1]), derivationSuffix: Utils.toBase64([Date.now() % 256, 2]), senderIdentityKey: fake.identityKey }
            const { publicKey } = await fake.proto.getPublicKey({ protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix), keyID: 'color', counterparty: fake.identityKey, forSelf: true })
            changeInfo = { custody, index: outs.length }
            outs.push({ lockingScript: new OneColor().lock(assetId, change, outputPubKeyHash(PublicKey.fromString(publicKey))).toHex(), satoshis: 1, outputDescription: 'token change', basket: colorBasket(assetId), customInstructions: await seal(custody), tags: ['color_offline'] })
          }
          // Owned plan outputs (a self-send) carry custody too.
          for (const o of plan.ownedOutputs ?? []) {
            outs[o.outputIndex] = { ...outs[o.outputIndex], basket: colorBasket(assetId), customInstructions: await seal({ assetId, derivationPrefix: o.derivationPrefix, derivationSuffix: o.derivationSuffix, senderIdentityKey: o.senderIdentityKey }), tags: ['color_offline'] }
          }
          const p = { inputs: picked, requested: args.outputs.length, ...(changeInfo != null ? { change: changeInfo } : {}) }
          const tokenOuts = outs.flatMap((o: any, index: number) => { const d = decodeToken(o.lockingScript); return d != null ? [{ index, amount: d.amount }] : [] })
          const ownedView = { ...p, change: changeInfo }
          // A self-send's owned outputs: model them as change custody for the plan check.
          const view = viewOf(assetId, undefined, ownedView, leaf, tokenOuts)
          for (const o of view.outputs) if (ownedIdx.has(o.outputIndex)) o.custody = await open(outs[o.outputIndex].customInstructions)
          await handler.checkPlanData!(ctxFor(assetId), leaf, view)
          await checkSpendable(assetId, picked.map(c => c.outpoint))
          const created = await target.createAction({ ...args, outputs: outs, inputs: picked.map(c => ({ outpoint: c.outpoint, unlockingScriptLength: 108, inputDescription: 'p color' })), options: { ...args.options, signAndProcess: false } })
          pending.set(created.signableTransaction.reference, { assetId, plan, inputs: picked, ...(changeInfo != null ? { change: changeInfo } : {}), requested: args.outputs.length })
          ;(pending.get(created.signableTransaction.reference) as any).view = view
          return created
        }
      }
      if (prop === 'signAction') {
        return async (args: any) => {
          const p = pending.get(args.reference) as any
          if (p == null) return await target.signAction(args)
          pending.delete(args.reference)
          const held = target.pending.get(args.reference)
          const tx: Transaction = held.tx
          const leaf = p.plan.profileData?.[MANDALA_PROFILE_ID]?.[p.assetId]
          const view = { ...p.view, tx }
          await handler.checkPlanData!(ctxFor(p.assetId), leaf, view)
          try {
            await checkSpendable(p.assetId, p.inputs.map((c: any) => c.outpoint))
          } catch (e) {
            await target.abortAction({ reference: args.reference })
            throw e
          }
          const spends: Record<string, { unlockingScript: string }> = {}
          for (let i = 0; i < p.inputs.length; i++) {
            const c = p.inputs[i]
            const priv = fake.proto.keyDeriver!.derivePrivateKey(colorProtocolID(c.custody.assetId, c.custody.derivationPrefix, c.custody.derivationSuffix), 'color', c.custody.senderIdentityKey)
            tx.inputs[i].unlockingScriptTemplate = new P2PKH().unlock(priv)
          }
          for (let i = 0; i < p.inputs.length; i++) {
            spends[String(i)] = { unlockingScript: (await tx.inputs[i].unlockingScriptTemplate!.sign(tx, i)).toHex() }
            tx.inputs[i].unlockingScriptTemplate = undefined
          }
          return await target.signAction({ ...args, spends })
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  }) as WalletInterface

  return {
    wallet,
    markSettled: async txid => {
      for (const o of fake.outputs.values()) if (o.tx.id('hex') === txid) o.tags = o.tags.filter(t => t !== 'color_offline')
    },
    coins: async assetId => (await coins(assetId)).map(({ outpoint, amount, offline }) => ({ outpoint, amount, offline }))
  }
}

