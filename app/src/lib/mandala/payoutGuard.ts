/**
 * Pure pre-submit gate for an issuer payout (B4): treasury value to a holder's
 * `p color` output. Exact bigint; the treasury is a sum (unbounded, 0162:143)
 * while the payout itself is one output (1..MAX_UINT64). Callers refuse
 * without starting wallet or overlay work when this fails; the lib and the
 * overlay re-check everything.
 */
import { guardPositiveAmount } from '@bsv/mandala/submitGuards'

export interface PayoutGuardInput {
  /** Parsed base units, or null when the field is empty or malformed. */
  amount: bigint | null
  /** Treasury units for the asset; undefined while not (yet) loaded. */
  treasury: bigint | undefined
  recipientKey: string
  /** The issuer's own identity key: a payout to it is refused (the lib requires another recipient). */
  issuerKey?: string | null
  isPaused: boolean
  /** Dev mode: let a paused payout reach the overlay to prove it enforces the pause. */
  pauseBypass: boolean
}

export type PayoutGuardResult = { ok: true } | { ok: false; reason: string }

/** Compressed secp256k1 identity key only: a `p color` output is derived against it. */
const COMPRESSED_KEY = /^(02|03)[0-9a-fA-F]{64}$/

export function guardPayout (i: PayoutGuardInput): PayoutGuardResult {
  if (i.amount == null) return { ok: false, reason: 'Enter an amount' }
  const pos = guardPositiveAmount(i.amount)
  if (!pos.ok) return pos
  if (i.treasury === undefined) return { ok: false, reason: 'Treasury balance unavailable — refresh' }
  if (i.amount > i.treasury) return { ok: false, reason: 'Amount exceeds treasury balance' }
  if (!COMPRESSED_KEY.test(i.recipientKey.trim())) {
    return { ok: false, reason: 'Recipient must be a compressed identity key' }
  }
  if (i.issuerKey != null && i.recipientKey.trim().toLowerCase() === i.issuerKey.toLowerCase()) {
    return { ok: false, reason: 'Recipient is the issuer — pay out to a holder' }
  }
  if (i.isPaused && !i.pauseBypass) {
    return { ok: false, reason: 'Transfers are temporarily disabled by the issuer' }
  }
  return { ok: true }
}

