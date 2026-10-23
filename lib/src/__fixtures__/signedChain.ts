/**
 * Test-only signed 1Color chains (design §9 B7 COVER / S1 tests): every input
 * is really signed (P2PKH under the 1Color prefix) so the hop script check is
 * exercised. σ is signed by the C.0 overlay key (overlaySigner.ts).
 */
import { P2PKH, PrivateKey, Transaction, type LockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { attestationFromSteak, type Attestation } from '../attestation.js'
import { commitmentPayload } from '../brc162.js'
import { encodeEnvelope } from '../encoding.js'
import { colorTopic } from '../naming.js'
import { OVERLAY_PRIV, signedSteak } from './overlaySigner.js'
import { linkage } from './colorHops.js'

export const DEPLOY_TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
export const ID = `${DEPLOY_TXID}_0`
export const A = new PrivateKey(1111)
export const B = new PrivateKey(2222)
export const ISSUER = new PrivateKey(4444)

export type Out = { lockingScript: LockingScript, satoshis: number }
export const pkh = (p: PrivateKey): number[] => p.toPublicKey().toHash() as number[]
export const tok = (amount: bigint, owner: PrivateKey, id = ID, sats = 1): Out => ({ lockingScript: new OneColor().lock(id, amount, pkh(owner)), satoshis: sats })
export const auth = (owner: PrivateKey, details: number[]): Out => ({ lockingScript: new OneColor().lock(ID, 0n, pkh(owner), commitmentPayload(details)), satoshis: 1 })
export const sats = (owner: PrivateKey, n = 1000): Out => ({ lockingScript: new P2PKH().lock(pkh(owner)), satoshis: n })

/** A tx spending `inputs` (each signed by its key) into `outputs`. */
export async function signed (inputs: Array<[Transaction, number, PrivateKey]>, outputs: Out[]): Promise<Transaction> {
  const tx = new Transaction()
  for (const [source, vout, key] of inputs) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(key), sequence: 0xffffffff })
  }
  for (const o of outputs) tx.addOutput(o)
  await tx.sign()
  return tx
}

/** A root with no inputs (never walked: it is σ-covered or absent). */
export function root (outputs: Out[]): Transaction {
  const tx = new Transaction()
  for (const o of outputs) tx.addOutput(o)
  return tx
}

export const env = (indices: number[], extra: Record<string, unknown> = {}): number[] =>
  encodeEnvelope({ outputs: indices.map(index => ({ index, linkage: linkage() })), ...extra } as any)

export async function sigma (tx: Transaction, outputs: number[], priv = OVERLAY_PRIV): Promise<Attestation> {
  const txid = tx.id('hex')
  return attestationFromSteak(txid, ID, await signedSteak(txid, { [colorTopic(ID)]: outputs }, priv))!
}

/** G (σ-covered root: 10 to A) → P (A: 10 → 10) → T (A: 10 → 6 to B + 4 to A). */
export async function chain () {
  const G = root([tok(10n, A), sats(A)])
  const P = await signed([[G, 0, A], [G, 1, A]], [tok(10n, A), sats(A, 900)])
  const T = await signed([[P, 0, A], [P, 1, A]], [tok(6n, B), tok(4n, A), sats(A, 800)])
  return { G, P, T, gSigma: await sigma(G, [0]) }
}

