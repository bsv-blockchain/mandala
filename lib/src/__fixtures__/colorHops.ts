/**
 * Test-only receipt-graph hops for the issuer-v1 `admitReceipt` and the
 * offline hop checks (C§4 local hop checks, Task 21).
 *
 * Chain: G (no inputs, a synthetic 10-unit coin of ID, never submitted) →
 * P (spends G.0 into one 10-unit output: conserves) → T (spends P.0 into 6 + 4).
 * Every token output carries 1 sat and every hop carries a full envelope, so
 * the default chain is policy-clean hop by hop. Envelope linkages are
 * well-formed but not decryptable: the hop checks never decrypt (the overlay
 * does), they only check coverage, verifier and keyID.
 */
import { P2PKH, PrivateKey, Transaction, UnlockingScript, type LockingScript } from '@bsv/sdk'
import { OneColor, isTokenShaped } from '@bsv/templates'
import { encodeEnvelope, type SpecificLinkage } from '../encoding.js'
import { colorProtocolID } from '../naming.js'
import { OVERLAY_KEY } from './overlaySigner.js'

export const DEPLOY_TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
export const ID = `${DEPLOY_TXID}_0`
export const OTHER_ID = `${'ab'.repeat(32)}_0`
/** Overlay identity key K (C.0 signer, priv 5555). */
export const K = OVERLAY_KEY
/** Sender A (priv 1111) and recipient B (priv 2222) identity keys. */
export const A_KEY = new PrivateKey(1111).toPublicKey().toString()
export const B_KEY = new PrivateKey(2222).toPublicKey().toString()

const PKH = new Array<number>(20).fill(7)
const FUND_PKH = new Array<number>(20).fill(9)

export interface OutSpec { id?: string | null, amount?: bigint, sats?: number, payload?: number[], script?: LockingScript }
export interface Hop { txid: string, atomicBEEF: number[], offChainValues: number[] }

/** A 1Color output (default: 1 sat of ID); `id: null` is a deploy. */
export function tokenOut (o: OutSpec = {}): { lockingScript: LockingScript, satoshis: number } {
  return {
    lockingScript: o.script ?? new OneColor().lock(o.id === undefined ? ID : o.id, o.amount ?? 1n, PKH, o.payload),
    satoshis: o.sats ?? 1
  }
}

export const plainOut = (satoshis = 1000): { lockingScript: LockingScript, satoshis: number } =>
  ({ lockingScript: new P2PKH().lock(FUND_PKH), satoshis })

/** An unsigned tx spending `inputs` (source tx, vout) into `outputs`. */
export function buildTx (
  inputs: Array<[Transaction, number]>,
  outputs: Array<{ lockingScript: LockingScript, satoshis: number }>
): Transaction {
  const tx = new Transaction()
  for (const [source, vout] of inputs) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  for (const o of outputs) tx.addOutput(o)
  return tx
}

export function linkage (over: Partial<SpecificLinkage> = {}): SpecificLinkage {
  return {
    prover: A_KEY,
    verifier: K,
    counterparty: B_KEY,
    protocolID: colorProtocolID(ID, 'AQ==', 'Ag=='),
    keyID: 'color',
    encryptedLinkage: [1, 2, 3],
    encryptedLinkageProof: [4, 5, 6],
    proofType: 0,
    ...over
  }
}

/** `{"outputs":[…]}` envelope bytes covering `indices`. */
export const envelope = (indices: number[], over: Partial<SpecificLinkage> = {}): number[] =>
  encodeEnvelope({ outputs: indices.map(index => ({ index, linkage: linkage(over) })) })

export const hopOf = (tx: Transaction, offChainValues: number[]): Hop =>
  ({ txid: tx.id('hex'), atomicBEEF: tx.toAtomicBEEF(), offChainValues })

/** G: the never-submitted root (a 10-unit coin of ID plus plain sats). */
export const G = buildTx([], [tokenOut({ amount: 10n }), plainOut(1000)])
/** P: G.0 → one 10-unit output (conserves). */
export const P = buildTx([[G, 0], [G, 1]], [tokenOut({ amount: 10n }), plainOut(900)])
/** T (tip): P.0 → 6 + 4. */
export const T = buildTx([[P, 0], [P, 1]], [tokenOut({ amount: 6n }), tokenOut({ amount: 4n }), plainOut(800)])

export const PARENT_OFFCHAIN = envelope([0])
export const TIP_OFFCHAIN = envelope([0, 1])
export const PARENT_HOP = hopOf(P, PARENT_OFFCHAIN)
export const TIP_HOP = hopOf(T, TIP_OFFCHAIN)

/** A tip spending P.0 into `outputs`, with an envelope over `covered` (default: every token output index). */
export function tipWith (outputs: Array<{ lockingScript: LockingScript, satoshis: number }>, covered?: number[]): Hop {
  const tx = buildTx([[P, 0], [P, 1]], outputs)
  const idx = covered ?? outputs.flatMap((o, i) => (isTokenShaped(o.lockingScript) ? [i] : []))
  return hopOf(tx, envelope(idx))
}
