/**
 * BRC-162 transaction fixtures: real Bsv21Binary scripts, real key linkage and
 * real deploy signatures, rooted in a funding tx with no inputs so the BEEF
 * needs no proofs. Copied from ts-stack
 * packages/overlays/topics/src/mandala/__tests/MandalaTopicManager.test.ts
 * (`funding`, `linkedLock`, `txSpending`, `build`, `deploy`, `issue`,
 * `transfer`) so the overlay's own tests build exactly what the package's do.
 *
 * Unlocking scripts are empty: the manager does not verify scripts. A test on
 * the real engine (SPV + script checks) needs signed unlocks on top.
 */
import { Hash, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import { Bsv21Binary, encodeStrictCbor } from '@bsv/templates'
import { deployDigest, encodeAdminDetails, encodeEnvelope, MANDALA_TOPIC } from '@bsv/overlay-topics'
import type { EngineOutputReader, MandalaEnvelope, SpecificLinkage } from '@bsv/overlay-topics'

export const codec = new Bsv21Binary()
export const FT: WalletProtocol = [2, 'mandala token']

export const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
export const walletOf = (hex: string): ProtoWallet => new ProtoWallet(PrivateKey.fromHex(hex))

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

export interface Spend { tx: Transaction, vout: number }

export interface Built {
  tx: Transaction
  txid: string
  previousCoins: number[]
  env: MandalaEnvelope
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

export async function linkedLock (out: TokenOut): Promise<{ script: LockingScript, linkage: SpecificLinkage }> {
  const keyID = `out-${++keyCounter}`
  const { publicKey } = await out.from.getPublicKey({ protocolID: FT, keyID, counterparty: out.to })
  const linkage = (await out.from.revealSpecificKeyLinkage({
    counterparty: out.to,
    verifier: OVERLAY,
    protocolID: FT,
    keyID
  })) as SpecificLinkage
  const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  return { script: codec.lock(out.tokenId, out.amount, pkh, out.payload), linkage }
}

/** Token spends first (they are the previous coins), then one funding input. */
export function txSpending (spends: readonly Spend[]): Transaction {
  const tx = new Transaction()
  for (const { tx: sourceTransaction, vout } of [...spends, { tx: funding(), vout: 0 }]) {
    tx.addInput({ sourceTransaction, sourceOutputIndex: vout, unlockingScript: new UnlockingScript() })
  }
  return tx
}

export async function build (
  spends: readonly Spend[],
  outs: readonly TokenOut[],
  admin: MandalaEnvelope['admin'] = []
): Promise<Built> {
  const tx = txSpending(spends)
  const outputs: MandalaEnvelope['outputs'] = []
  for (const [index, out] of outs.entries()) {
    const { script, linkage } = await linkedLock(out)
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    outputs.push({ index, linkage })
  }
  return { tx, txid: tx.id('hex'), previousCoins: spends.map((_, i) => i), env: { inputs: [], outputs, admin } }
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

/** A signed deploy, locked to the deployer's own derived key (spec §5.1a). */
export async function deploy (by = issuer, byKey = ISSUER, payload = DEPLOY_PAYLOAD): Promise<Built> {
  const b = await build([], [{ tokenId: null, amount: 0n, from: by, to: byKey, payload }])
  return { ...b, env: { ...b.env, deploySig: await signDeploy(by, b.txid) } }
}

export const tokenOf = (d: Built): string => `${d.txid}_0`

export const commitTo = (details: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(details)) })

/** Spends `authority`: output 0 is value to `to`, output 1 the authority committing `details`. */
export async function issue (
  tokenId: string,
  authority: Spend,
  amount: bigint,
  details: number[] = encodeAdminDetails({ kind: 'issue' }),
  to = HOLDER
): Promise<Built> {
  return await build(
    [authority],
    [
      { tokenId, amount, from: issuer, to },
      { tokenId, amount: 0n, from: issuer, to: ISSUER, payload: commitTo(details) }
    ],
    [{ index: 1, details: Utils.toHex(details) }]
  )
}

export async function transfer (
  tokenId: string,
  coin: Spend,
  from: ProtoWallet,
  to: ReadonlyArray<[string, bigint]>
): Promise<Built> {
  return await build([coin], to.map(([key, amount]) => ({ tokenId, amount, from, to: key })))
}

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
