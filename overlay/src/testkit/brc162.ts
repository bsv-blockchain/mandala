/**
 * BRC-162 transaction fixtures: real Bsv21Binary scripts, real key linkage and
 * real deploy signatures, rooted in a funding tx with no inputs so the BEEF
 * needs no proofs. Copied from ts-stack
 * packages/overlays/topics/src/mandala/__tests/MandalaTopicManager.test.ts
 * (`funding`, `linkedLock`, `txSpending`, `build`, `deploy`, `issue`,
 * `transfer`) so the overlay's own tests build exactly what the package's do.
 *
 * Unlocking scripts are empty: the manager does not verify scripts. A test on
 * the real engine (SPV + script checks) uses `signedFixtures` instead: real
 * Bsv21Binary unlocks of the derived child keys, funded from a coin with a
 * merkle path (the engine harness `root`).
 */
import { Hash, KeyDeriver, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { Bsv21Binary, encodeStrictCbor } from '@bsv/templates'
import { deployDigest, encodeAdminDetails, encodeEnvelope, MANDALA_TOPIC } from '@bsv/overlay-topics'
import type { EngineOutputReader, MandalaEnvelope, SpecificLinkage } from '@bsv/overlay-topics'

export const codec = new Bsv21Binary()
export const FT: WalletProtocol = [2, 'p mandala token']

export const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()

/** Identity key → private key of every fixture wallet, so a signed spend can derive its child key. */
const PRIVS = new Map<string, PrivateKey>()
/** Fixture wallet → its identity key. */
const IDENTITIES = new WeakMap<ProtoWallet, string>()

export const walletOf = (hex: string): ProtoWallet => {
  const priv = PrivateKey.fromHex(hex)
  const wallet = new ProtoWallet(priv)
  PRIVS.set(priv.toPublicKey().toString(), priv)
  IDENTITIES.set(wallet, priv.toPublicKey().toString())
  return wallet
}

/** The overlay's own key: verifier of every linkage, and `SERVER_PRIVATE_KEY` in tests. */
export const OVERLAY_HEX = '0a'.repeat(32)
export const overlay = walletOf(OVERLAY_HEX)
export const issuer = walletOf('66'.repeat(32))
export const holder = walletOf('44'.repeat(32))
export const receiver = walletOf('22'.repeat(32))
export const rogue = walletOf('33'.repeat(32))
export const OVERLAY = keyOf(OVERLAY_HEX)
export const ISSUER = keyOf('66'.repeat(32))
export const HOLDER = keyOf('44'.repeat(32))
export const RECEIVER = keyOf('22'.repeat(32))
export const ROGUE = keyOf('33'.repeat(32))
/** The manager only calls `decrypt` on the verifier, which ProtoWallet implements. */
export const verifierWallet = overlay as unknown as WalletInterface

export const DEPLOY_PAYLOAD = encodeStrictCbor({ sym: 'USD', dec: 2, label: 'US Dollar' })

export interface TokenOut {
  /** null: a deploy. */
  tokenId: string | null
  amount: bigint
  /** Reveals the linkage; the output is locked to `to`'s key derived by `from`. */
  from: ProtoWallet
  to: string
  payload?: number[]
}

/** `key`: the child key that unlocks the coin; required by `signedFixtures`, ignored otherwise. */
export interface Spend { tx: Transaction, vout: number, key?: PrivateKey }

/** How a token output's key was derived (spec §5.1a), so its owner can spend it. */
export interface OutputKey { keyID: string, from: string, to: string, publicKey: string }

export interface Built {
  tx: Transaction
  txid: string
  previousCoins: number[]
  env: MandalaEnvelope
  /** Per token output index (the fixture's outputs come first, in order). */
  keys: OutputKey[]
}

let nonce = 0
let keyCounter = 0

/** Roots every chain in a funding tx with no inputs, so BEEF needs no proofs. */
export function funding (): Transaction {
  const source = new Transaction()
  source.lockTime = ++nonce
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160([nonce])) })
  return source
}

export async function linkedLock (out: TokenOut): Promise<{ script: LockingScript, linkage: SpecificLinkage, key: OutputKey }> {
  const keyID = `out-${++keyCounter}`
  const { publicKey } = await out.from.getPublicKey({ protocolID: FT, keyID, counterparty: out.to })
  const linkage = (await out.from.revealSpecificKeyLinkage({
    counterparty: out.to,
    verifier: OVERLAY,
    protocolID: FT,
    keyID
  })) as SpecificLinkage
  const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  const from = IDENTITIES.get(out.from) ?? (await out.from.getPublicKey({ identityKey: true })).publicKey
  return { script: codec.lock(out.tokenId, out.amount, pkh, out.payload), linkage, key: { keyID, from, to: out.to, publicKey } }
}

/**
 * The owner's child private key for a token output: the recipient derives with
 * the prover as counterparty (BRC-42), which is the key `linkedLock` locked to.
 */
export function childKeyOf (k: OutputKey): PrivateKey {
  const owner = PRIVS.get(k.to)
  if (owner === undefined) throw new Error(`fixture: no private key for owner ${k.to}`)
  const child = new KeyDeriver(owner).derivePrivateKey(FT, k.keyID, k.from)
  if (child.toPublicKey().toString() !== k.publicKey) {
    throw new Error(`fixture: derived child key for ${k.keyID} does not match the locked key`)
  }
  return child
}

/** A spend of `b`'s token output `vout`, carrying the owner's child key for a signed unlock. */
export const coinOf = (b: Built, vout: number): Spend => ({ tx: b.tx, vout, key: childKeyOf(b.keys[vout]) })

/**
 * Where a fixture transaction's inputs come from and how it is finished.
 * Unsigned (the default): empty unlocks and a proofless `funding()` input.
 */
export interface Funder {
  inputs: (tx: Transaction, spends: readonly Spend[]) => void
  finish: (tx: Transaction, tokenOutputs: number) => Promise<void>
}

const unsignedFunder: Funder = {
  inputs: (tx, spends) => {
    for (const { tx: sourceTransaction, vout } of [...spends, { tx: funding(), vout: 0 }]) {
      tx.addInput({ sourceTransaction, sourceOutputIndex: vout, unlockingScript: new UnlockingScript() })
    }
  },
  finish: async () => {}
}

/** Token spends first (they are the previous coins), then one funding input. */
export function txSpending (spends: readonly Spend[]): Transaction {
  const tx = new Transaction()
  unsignedFunder.inputs(tx, spends)
  return tx
}

/**
 * Signed inputs for the real engine (SPV + script checks): every token spend
 * is unlocked with its owner's child key, and one P2PKH funding input spends
 * `coin` (first the harness `root`, which has a merkle path, then each
 * transaction's change). The change goes LAST, after the token outputs, so the
 * fixture's token output indices are unchanged; it is not token-shaped, so the
 * manager ignores it and the engine never stores it.
 */
export const chainFunder = (root: Transaction, rootKey: PrivateKey, vout = 0): Funder => {
  const change = new P2PKH().lock(rootKey.toPublicKey().toAddress())
  let coin: { tx: Transaction, vout: number } = { tx: root, vout }
  return {
    inputs: (tx, spends) => {
      for (const s of spends) {
        if (s.key === undefined) throw new Error('fixture: a signed spend needs the coin\'s child key (use coinOf)')
        tx.addInput({ sourceTransaction: s.tx, sourceOutputIndex: s.vout, unlockingScriptTemplate: codec.unlock(s.key), sequence: 0xffffffff })
      }
      tx.addInput({ sourceTransaction: coin.tx, sourceOutputIndex: coin.vout, unlockingScriptTemplate: new P2PKH().unlock(rootKey), sequence: 0xffffffff })
    },
    finish: async (tx, tokenOutputs) => {
      const funded = coin.tx.outputs[coin.vout].satoshis ?? 0
      if (funded <= tokenOutputs) throw new Error('fixture: funding chain exhausted')
      tx.addOutput({ lockingScript: change, satoshis: funded - tokenOutputs })
      await tx.sign()
      coin = { tx, vout: tx.outputs.length - 1 }
    }
  }
}

async function buildWith (
  funder: Funder,
  spends: readonly Spend[],
  outs: readonly TokenOut[],
  admin: MandalaEnvelope['admin'] = []
): Promise<Built> {
  const tx = new Transaction()
  funder.inputs(tx, spends)
  const outputs: MandalaEnvelope['outputs'] = []
  const keys: OutputKey[] = []
  for (const [index, out] of outs.entries()) {
    const { script, linkage, key } = await linkedLock(out)
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    outputs.push({ index, linkage })
    keys.push(key)
  }
  // Signing fixes the txid, so it is read only after `finish`.
  await funder.finish(tx, outs.length)
  return { tx, txid: tx.id('hex'), previousCoins: spends.map((_, i) => i), env: { inputs: [], outputs, admin }, keys }
}

export async function build (
  spends: readonly Spend[],
  outs: readonly TokenOut[],
  admin: MandalaEnvelope['admin'] = []
): Promise<Built> {
  return await buildWith(unsignedFunder, spends, outs, admin)
}

export async function signDeploy (wallet: ProtoWallet, txid: string): Promise<string> {
  const { signature } = await wallet.createSignature({
    data: deployDigest(txid),
    protocolID: [2, 'mandala deploy'],
    keyID: '1',
    counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

export const tokenOf = (d: Built): string => `${d.txid}_0`

export const commitTo = (details: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(details)) })

/**
 * The deploy / issue / transfer builders over one `Funder`. The module-level
 * exports are the unsigned set; `fixturesWith(chainFunder(root, key))` builds
 * the same transactions with real unlocks for the real engine.
 */
export const fixturesWith = (funder: Funder) => {
  const buildOn = async (spends: readonly Spend[], outs: readonly TokenOut[], admin: MandalaEnvelope['admin'] = []): Promise<Built> =>
    await buildWith(funder, spends, outs, admin)

  /** A signed deploy, locked to the deployer's own derived key (spec §5.1a). */
  const deploy = async (by = issuer, byKey = ISSUER, payload = DEPLOY_PAYLOAD): Promise<Built> => {
    const b = await buildOn([], [{ tokenId: null, amount: 0n, from: by, to: byKey, payload }])
    return { ...b, env: { ...b.env, deploySig: await signDeploy(by, b.txid) } }
  }

  /** Spends `authority`: output 0 is value to `to`, output 1 the authority committing `details`. */
  const issue = async (
    tokenId: string,
    authority: Spend,
    amount: bigint,
    details: number[] = encodeAdminDetails({ kind: 'issue' }),
    to = HOLDER
  ): Promise<Built> =>
    await buildOn(
      [authority],
      [
        { tokenId, amount, from: issuer, to },
        { tokenId, amount: 0n, from: issuer, to: ISSUER, payload: commitTo(details) }
      ],
      [{ index: 1, details: Utils.toHex(details) }]
    )

  const transfer = async (
    tokenId: string,
    coin: Spend,
    from: ProtoWallet,
    to: ReadonlyArray<[string, bigint]>
  ): Promise<Built> =>
    await buildOn([coin], to.map(([key, amount]) => ({ tokenId, amount, from, to: key })))

  return { build: buildOn, deploy, issue, transfer }
}

const unsigned = fixturesWith(unsignedFunder)
export const { deploy, issue, transfer } = unsigned

/** The off-chain values the manager reads (the envelope), as the engine passes them. */
export const envelopeOf = (b: Built): number[] => encodeEnvelope(b.env)

/**
 * An in-memory stand-in for the engine's admitted-output store. Tests on the
 * real engine use `knexEngineOutputs(knex)` instead.
 */
export const memEngineOutputs = (
  admitted = new Map<string, { lockingScript: number[], satoshis: number }>()
): EngineOutputReader & { admitted: typeof admitted } => ({
  admitted,
  findAdmittedOutput: async (txid, outputIndex, topic) =>
    topic === MANDALA_TOPIC ? (admitted.get(`${txid}.${outputIndex}`) ?? null) : null,
  listUnspentAdmittedOutputs: async () => []
})
