/**
 * issuer-v1 `admitReceipt` (design §9 B7; replaces the baseline receipt
 * admission, 0207:126-141).
 *
 * The handler credits only what the host itself verified:
 *
 * 1. The host ledger (the in-process object the host built the handler with;
 *    no app can write it) holds a record for the receipt's txid, of this
 *    asset, whose `outputs` include the receipt output:
 *      `settled` ⇒ `{credit: 'settled'}` (σ by K verified by the host);
 *      `pending` ⇒ `{credit: 'pending'}` (COVER + S1 hop checks passed
 *                  offline; the module tags it `color_offline`);
 *      `refused` ⇒ throw (a final overlay verdict).
 * 2. Anything else (an app internalized over BRC-100, or the host did not
 *    verify this output): the handler submits the receipt's AtomicBEEF
 *    itself, with no envelope. The overlay answers an already-admitted tx
 *    with its σ (idempotent replay, overlay-go serveKnownVerdict); a
 *    transaction it has not admitted is refused. The σ must verify under K
 *    and cover the output, and is then recorded `settled`. Any refusal,
 *    transport failure or uncovered output throws: no credit.
 *
 * Stability: the ledger write after a self-submit is a merge (never a
 * downgrade); a crash before it only means the next receipt re-submits.
 * Errors cross the module boundary by `.name` and the `[ClassName] ` prefix.
 */
import { Utils } from '@bsv/sdk'
import { ProfileDataError, type ColorOverlayProvider, type ProfileAssetContext } from '@bsv/color-permission-module'
import { attestationFromSteak, verifyAttestation } from './attestation.js'
import type { HostLedger } from './hostLedger.js'
import { colorTopic } from './naming.js'
import { issuerKey } from './profileDescriptor.js'
import type { ProfileReceiptCredit, ProfileReceiptView } from './profileTypes.js'

const dataError = (reason: string): ProfileDataError =>
  new ProfileDataError(`BRC-207: Mandala issuer-v1 receipt: ${reason}`)

const TXID = /^[0-9a-f]{64}$/

export async function admitReceipt (
  ctx: ProfileAssetContext,
  receipt: ProfileReceiptView,
  provider: (k: string) => ColorOverlayProvider,
  ledger: HostLedger
): Promise<ProfileReceiptCredit> {
  const K = issuerKey(ctx.descriptor)
  // S5: no endpoint for K ⇒ ProfileParamsError, before anything else.
  const overlay = provider(K)
  if (receipt == null || typeof receipt !== 'object') throw dataError('the receipt is missing')
  const { txid, outputIndex, beef } = receipt
  if (receipt.assetId !== ctx.assetId) throw dataError('the receipt names another asset')
  if (typeof txid !== 'string' || !TXID.test(txid)) throw dataError('the receipt has no txid')
  if (!Number.isInteger(outputIndex) || outputIndex < 0) throw dataError('the receipt has no output index')

  const record = await ledger.get(txid)
  if (record != null && record.assetId === ctx.assetId && record.outputs.includes(outputIndex)) {
    if (record.state === 'settled') return { credit: 'settled' }
    if (record.state === 'pending') return { credit: 'pending' }
    throw dataError(`the overlay refused ${txid} for good (${record.code ?? 'final'})`)
  }

  // Not verified by this host: submit it ourselves and require admission.
  if (!Array.isArray(beef) || beef.length === 0) throw dataError('the receipt carries no transaction bytes')
  const steak = await overlay.submit([colorTopic(ctx.assetId)], beef) // a refusal or transport failure propagates: no credit
  const att = attestationFromSteak(txid, ctx.assetId, steak)
  if (att == null || !verifyAttestation(att, ctx.assetId, K)) throw dataError('the overlay answered without a verifiable admission')
  if (!att.outputs.includes(outputIndex)) throw dataError(`the admission does not cover output ${outputIndex}`)
  await ledger.put({ v: 1, txid, assetId: ctx.assetId, state: 'settled', outputs: [outputIndex], attestation: att, beefHex: Utils.toHex(beef), at: Date.now() })
  return { credit: 'settled' }
}
