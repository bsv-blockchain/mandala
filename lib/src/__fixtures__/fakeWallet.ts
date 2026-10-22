/**
 * Test-only underlying BRC-100 wallet for the issuer-v1 integration test
 * (plan 04 Task 22). Written fresh here; the shape mirrors the color module's
 * own test fixture, but nothing is imported from T2's sources.
 *
 * - Keys: a real `ProtoWallet` (BRC-42/43 derivation, BRC-2 encryption,
 *   linkage revelation, HMAC, signatures).
 * - Actions: two-phase `createAction`/`signAction`/`abortAction`. Every input
 *   script is verified with the script interpreter before an action is
 *   finalized. A `noSend` action is held (`nosend`) until `sendWith`.
 * - Funding: satoshis come from a synthetic, unproven funding tx per wallet
 *   (no inputs, P2PKH outputs to the wallet's root key), so every AtomicBEEF
 *   this wallet produces carries no BUMPs (plan 04 R1). One funding input is
 *   appended after the caller's inputs; there is no satoshi change output.
 * - Outputs: an in-memory store with baskets, tags and customInstructions;
 *   `listOutputs` serves plain baskets (tags + `tagQueryMode`, paging) and the
 *   toolbox `specOpBasketPrefixOutputs` inventory the color module reads.
 *
 * This file must not name the color module (core isolation scans fixtures):
 * `ColorModuleStore` is declared structurally below.
 */
import {
  Beef, LockingScript, P2PKH, PrivateKey, ProtoWallet, Spend, Transaction, UnlockingScript,
  type CreateActionArgs, type CreateActionResult, type InternalizeActionArgs, type ListActionsArgs,
  type ListActionsResult, type ListOutputsArgs, type ListOutputsResult, type SignActionArgs,
  type SignActionResult, type WalletInterface
} from '@bsv/sdk'

/** The toolbox `sdk.specOpBasketPrefixOutputs` value (every output whose basket starts with `tags[0] + ' '`). */
export const SPEC_OP_BASKET_PREFIX_OUTPUTS = 'b9184a72141e6a4d3d148c67a6d0ad92864a4d85290579ea5bef8bd62eb01b6f'

/** Structural `ColorModuleStore` (C§2.1): durable async key-value store the module writes under `color.v1.`. */
export interface MemoryColorStore {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: (prefix: string) => Promise<string[]>
  readonly entries: Map<string, string>
}

export function memoryColorStore (): MemoryColorStore {
  const entries = new Map<string, string>()
  return {
    entries,
    get: async key => entries.get(key),
    set: async (key, value) => { entries.set(key, value) },
    delete: async key => { entries.delete(key) },
    keys: async prefix => [...entries.keys()].filter(k => k.startsWith(prefix)).sort()
  }
}

interface StoredOutput {
  tx: Transaction
  vout: number
  basket?: string
  customInstructions?: string
  tags: string[]
  spent: boolean
  /** The pending action reference that holds this output as an input. */
  reservedBy?: string
}

interface ActionRecord {
  reference: string
  txid: string
  labels: string[]
  status: 'nosend' | 'unproven' | 'failed'
  /** Outpoints this action spent (restored on abort). */
  inputs: string[]
}

const FUNDING_OUTPUTS = 50
const FUNDING_SATOSHIS = 1000

/** Validates one input's unlocking script against its source output with the script interpreter. */
export function validInput (tx: Transaction, inputIndex: number): boolean {
  const input = tx.inputs[inputIndex]
  const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (source == null || input.unlockingScript == null) return false
  try {
    return new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      outputs: tx.outputs,
      inputIndex,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    }).validate()
  } catch {
    return false
  }
}

export class FakeWallet {
  readonly priv: PrivateKey
  readonly proto: ProtoWallet
  readonly identityKey: string
  readonly outputs = new Map<string, StoredOutput>()
  readonly pending = new Map<string, { tx: Transaction, args: CreateActionArgs, inputs: string[] }>()
  readonly actions = new Map<string, ActionRecord>()
  /** The txids of every `sendWith` call, one array per call. */
  readonly sentWith: string[][] = []
  #nextReference = 0
  #funding: Transaction | undefined
  #fundingNext = 0

  constructor (priv: PrivateKey = PrivateKey.fromRandom()) {
    this.priv = priv
    this.proto = new ProtoWallet(priv)
    this.identityKey = priv.toPublicKey().toString()
  }

  asWallet (): WalletInterface {
    return this as unknown as WalletInterface
  }

  // --- keys (delegated to ProtoWallet; the second originator argument is ignored) ---
  getPublicKey: WalletInterface['getPublicKey'] = async args => await this.proto.getPublicKey(args)
  createSignature: WalletInterface['createSignature'] = async args => await this.proto.createSignature(args)
  verifySignature: WalletInterface['verifySignature'] = async args => await this.proto.verifySignature(args)
  encrypt: WalletInterface['encrypt'] = async args => await this.proto.encrypt(args)
  decrypt: WalletInterface['decrypt'] = async args => await this.proto.decrypt(args)
  createHmac: WalletInterface['createHmac'] = async args => await this.proto.createHmac(args)
  verifyHmac: WalletInterface['verifyHmac'] = async args => await this.proto.verifyHmac(args)
  revealCounterpartyKeyLinkage: WalletInterface['revealCounterpartyKeyLinkage'] = async args =>
    await this.proto.revealCounterpartyKeyLinkage(args)
  revealSpecificKeyLinkage: WalletInterface['revealSpecificKeyLinkage'] = async args =>
    await this.proto.revealSpecificKeyLinkage(args)
  getNetwork: WalletInterface['getNetwork'] = async () => ({ network: 'mainnet' })
  getVersion: WalletInterface['getVersion'] = async () => ({ version: 'fake-1.0.0' })
  isAuthenticated: WalletInterface['isAuthenticated'] = async () => ({ authenticated: true })
  waitForAuthentication: WalletInterface['waitForAuthentication'] = async () => ({ authenticated: true })
  getHeight: WalletInterface['getHeight'] = async () => ({ height: 1 })

  // --- funding ---

  /** The wallet's root P2PKH lock (funding outputs). */
  fundingLock (): LockingScript {
    return new P2PKH().lock(this.priv.toPublicKey().toHash() as number[])
  }

  /** The next unused funding outpoint (a fresh synthetic funding tx when the last one is used up). */
  #nextFunding (): { tx: Transaction, vout: number } {
    if (this.#funding == null || this.#fundingNext >= FUNDING_OUTPUTS) {
      const tx = new Transaction()
      for (let i = 0; i < FUNDING_OUTPUTS; i++) tx.addOutput({ lockingScript: this.fundingLock(), satoshis: FUNDING_SATOSHIS })
      this.#funding = tx
      this.#fundingNext = 0
    }
    return { tx: this.#funding, vout: this.#fundingNext++ }
  }

  /** Signs every input of `tx` that spends a funding output of this wallet (SIGHASH_ALL|FORKID). */
  async signFunding (tx: Transaction): Promise<void> {
    const lock = this.fundingLock().toHex()
    for (const input of tx.inputs) {
      const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (source?.lockingScript.toHex() === lock) input.unlockingScriptTemplate = new P2PKH().unlock(this.priv)
    }
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
      if (input.unlockingScriptTemplate != null) {
        input.unlockingScript = await input.unlockingScriptTemplate.sign(tx, i)
        input.unlockingScriptTemplate = undefined
      }
    }
  }

  // --- actions ---

  store (tx: Transaction, vout: number, basket?: string, customInstructions?: string, tags?: string[]): void {
    this.outputs.set(`${tx.id('hex')}.${vout}`, {
      tx, vout, ...(basket != null ? { basket } : {}), ...(customInstructions != null ? { customInstructions } : {}), tags: [...(tags ?? [])], spent: false
    })
  }

  async createAction (args: CreateActionArgs): Promise<CreateActionResult> {
    const sendWith = args.options?.sendWith
    if (sendWith != null && sendWith.length > 0) {
      this.sentWith.push([...sendWith])
      for (const action of this.actions.values()) {
        if (sendWith.includes(action.txid) && action.status === 'nosend') action.status = 'unproven'
      }
      return { sendWithResults: sendWith.map(txid => ({ txid, status: 'unproven' as const })) }
    }
    const reference = `reference-${this.#nextReference++}`
    const tx = new Transaction()
    const spent: string[] = []
    for (const input of args.inputs ?? []) {
      const stored = this.outputs.get(input.outpoint)
      if (stored == null || stored.spent || stored.reservedBy != null) {
        for (const op of spent) this.outputs.get(op)!.reservedBy = undefined
        throw new Error(`FakeWallet: input ${input.outpoint} is not available`)
      }
      stored.reservedBy = reference
      spent.push(input.outpoint)
      tx.addInput({
        sourceTransaction: stored.tx,
        sourceOutputIndex: stored.vout,
        unlockingScript: input.unlockingScript != null ? UnlockingScript.fromHex(input.unlockingScript) : new UnlockingScript(),
        sequence: input.sequenceNumber ?? 0xffffffff
      })
    }
    const funding = this.#nextFunding()
    tx.addInput({ sourceTransaction: funding.tx, sourceOutputIndex: funding.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    for (const output of args.outputs ?? []) {
      tx.addOutput({ lockingScript: LockingScript.fromHex(output.lockingScript), satoshis: output.satoshis })
    }
    if (args.lockTime != null) tx.lockTime = args.lockTime
    if (args.version != null) tx.version = args.version

    const unsigned = (args.inputs ?? []).some(i => i.unlockingScript == null)
    if (unsigned || args.options?.signAndProcess === false) {
      this.pending.set(reference, { tx, args, inputs: spent })
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference } }
    }
    const noSend = args.options?.noSend === true
    const done = await this.#finalize(reference, tx, args, spent, noSend)
    return { txid: done.txid, tx: done.tx, ...(noSend ? { noSendChange: [] } : {}) }
  }

  async signAction (args: SignActionArgs): Promise<SignActionResult> {
    const pending = this.pending.get(args.reference)
    if (pending == null) throw new Error('FakeWallet: unknown reference')
    for (const [index, spend] of Object.entries(args.spends ?? {})) {
      pending.tx.inputs[Number(index)].unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
    }
    const noSend = (args.options?.noSend ?? pending.args.options?.noSend) === true
    this.pending.delete(args.reference)
    try {
      const done = await this.#finalize(args.reference, pending.tx, pending.args, pending.inputs, noSend)
      return { txid: done.txid, tx: done.tx }
    } catch (e) {
      // A failed sign releases the action, as the toolbox does.
      for (const op of pending.inputs) {
        const o = this.outputs.get(op)
        if (o != null) o.reservedBy = undefined
      }
      throw e
    }
  }

  async #finalize (reference: string, tx: Transaction, args: CreateActionArgs, inputs: string[], noSend: boolean): Promise<{ txid: string, tx: number[] }> {
    await this.signFunding(tx)
    for (let i = 0; i < tx.inputs.length; i++) {
      if (!validInput(tx, i)) throw new Error(`FakeWallet: input ${i} does not unlock`)
    }
    const txid = tx.id('hex')
    for (const op of inputs) {
      const o = this.outputs.get(op)!
      o.spent = true
      o.reservedBy = undefined
    }
    ;(args.outputs ?? []).forEach((output, vout) => {
      this.store(tx, vout, output.basket, output.customInstructions, output.tags)
    })
    this.actions.set(reference, {
      reference, txid, labels: [...(args.labels ?? [])], status: noSend ? 'nosend' : 'unproven', inputs: [...inputs]
    })
    return { txid, tx: tx.toAtomicBEEF() }
  }

  async abortAction (args: { reference: string }): Promise<{ aborted: true }> {
    const pending = this.pending.get(args.reference)
    if (pending != null) {
      this.pending.delete(args.reference)
      for (const op of pending.inputs) {
        const o = this.outputs.get(op)
        if (o != null) o.reservedBy = undefined
      }
      return { aborted: true }
    }
    const action = this.actions.get(args.reference)
    if (action == null) throw new Error('FakeWallet: unknown reference')
    if (action.status !== 'nosend') throw new Error(`FakeWallet: action ${action.txid} is ${action.status} and cannot be aborted`)
    action.status = 'failed'
    for (const op of action.inputs) {
      const o = this.outputs.get(op)
      if (o != null) o.spent = false
    }
    for (const [op, o] of this.outputs) if (o.tx.id('hex') === action.txid) this.outputs.delete(op)
    return { aborted: true }
  }

  async listActions (args: ListActionsArgs): Promise<ListActionsResult> {
    const all = args.labelQueryMode === 'all'
    const labels = args.labels ?? []
    const matching = [...this.actions.values()].filter(a =>
      a.status !== 'failed' &&
      (labels.length === 0 || (all ? labels.every(l => a.labels.includes(l)) : labels.some(l => a.labels.includes(l))))
    )
    const offset = args.offset ?? 0
    const page = matching.slice(offset, offset + (args.limit ?? 10))
    return {
      totalActions: matching.length,
      actions: page.map(a => ({
        txid: a.txid,
        satoshis: 0,
        status: a.status as ListActionsResult['actions'][number]['status'],
        isOutgoing: true,
        description: 'Fake action',
        version: 1,
        lockTime: 0,
        ...(args.includeLabels === true ? { labels: [...a.labels] } : {})
      }))
    }
  }

  async listOutputs (args: ListOutputsArgs): Promise<ListOutputsResult> {
    const inventory = args.basket === SPEC_OP_BASKET_PREFIX_OUTPUTS
    const tags = args.tags ?? []
    const tagMatch = (o: StoredOutput): boolean => {
      if (inventory || tags.length === 0) return true
      return args.tagQueryMode === 'all' ? tags.every(t => o.tags.includes(t)) : tags.some(t => o.tags.includes(t))
    }
    const records = [...this.outputs.entries()]
      .filter(([, o]) => !o.spent && (inventory
        ? o.basket?.startsWith(`${tags[0] ?? ''} `) === true
        : o.reservedBy == null && o.basket === args.basket && tagMatch(o)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const offset = args.offset ?? 0
    const page = inventory ? records : records.slice(offset, offset + (args.limit ?? 10))
    const beef = new Beef()
    const result: ListOutputsResult = {
      totalOutputs: records.length,
      outputs: page.map(([outpoint, o]) => {
        if (args.include === 'entire transactions') beef.mergeTransaction(o.tx)
        return {
          outpoint,
          satoshis: o.tx.outputs[o.vout].satoshis!,
          spendable: o.reservedBy == null,
          ...(args.include === 'locking scripts' ? { lockingScript: o.tx.outputs[o.vout].lockingScript.toHex() } : {}),
          ...(args.includeCustomInstructions === true && o.customInstructions != null ? { customInstructions: o.customInstructions } : {}),
          ...(args.includeTags === true ? { tags: [...o.tags] } : {})
        }
      })
    }
    if (args.include === 'entire transactions') result.BEEF = beef.toBinary()
    return result
  }

  async internalizeAction (args: InternalizeActionArgs): Promise<{ accepted: true }> {
    const tx = Transaction.fromAtomicBEEF(args.tx)
    for (const output of args.outputs) {
      const r = output.insertionRemittance
      if (output.protocol === 'basket insertion' && r != null) {
        this.store(tx, output.outputIndex, r.basket, r.customInstructions, r.tags)
      }
    }
    return { accepted: true }
  }
}

/**
 * A `WalletInterface` view of `wallet` that passes `originator` on every call
 * (the lib calls its wallet without one; a WalletPermissionsManager treats a
 * missing originator as an unprivileged app).
 */
export function withOriginator (wallet: WalletInterface, originator: string): WalletInterface {
  return new Proxy(wallet as any, {
    get (target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return (args: unknown) => v.call(target, args ?? {}, originator)
    }
  }) as WalletInterface
}
