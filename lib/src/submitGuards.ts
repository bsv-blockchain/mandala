/**
 * Pure pre-submit gates for holder send and issuer mutations.
 * Callers must reject without starting wallet/overlay work when these fail.
 * Each guard returns { ok: true } when the submit is allowed, or
 * { ok: false, reason } with a human-readable reason.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string }

function fail(reason: string): GuardResult {
  return { ok: false, reason }
}

const ok: GuardResult = { ok: true }

/** Positive integer base units (on-chain amount). */
export function guardPositiveAmount(amount: number): GuardResult {
  if (!Number.isFinite(amount) || Number.isNaN(amount)) {
    return fail('Amount is not a valid number')
  }
  if (!Number.isInteger(amount)) {
    return fail('Amount must be a whole number of base units')
  }
  if (amount <= 0) {
    return fail('Amount must be greater than zero')
  }
  return ok
}

export interface SendSubmitInput {
  assetId: string
  recipientKey: string
  amount: number
  balance: number
  /** When true and not bypassed, reject before any wallet work. */
  isPaused: boolean
  /** Dev mode intentionally reaches the overlay on a paused asset. */
  pauseBypass?: boolean
  walletReady: boolean
}

/** Holder send confirm — all client-side gates before transferTokens. */
export function guardSendSubmit(input: SendSubmitInput): GuardResult {
  if (!input.walletReady) return fail('Wallet not ready')
  if (input.assetId.trim() === '') return fail('Select an asset')
  if (input.recipientKey.trim() === '') return fail('Enter a recipient')
  const pos = guardPositiveAmount(input.amount)
  if (!pos.ok) return pos
  if (input.amount > input.balance) return fail('Amount exceeds available balance')
  if (input.isPaused && !input.pauseBypass) {
    return fail('Transfers are temporarily disabled by the issuer')
  }
  return ok
}

export interface IssueRedeemSubmitInput {
  assetId: string
  amount: number
  /** Redeem only — must not burn more than held. Issue has no upper bound here. */
  balance?: number
  walletReady: boolean
  /**
   * Issue only — sha256 hex of the off-chain deposit record, committed on-chain
   * as `bankRef` (R12). Must be a 64-hex digest when given: the raw bank
   * reference itself must never reach the chain.
   */
  bankRef?: string
  /** Issue only — refuse a ref-less issue when the deployment mandates a deposit ref. */
  requireBankRef?: boolean
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/

export function guardIssueSubmit(input: IssueRedeemSubmitInput): GuardResult {
  if (!input.walletReady) return fail('Wallet not ready')
  if (input.assetId.trim() === '') return fail('Select an asset')
  const pos = guardPositiveAmount(input.amount)
  if (!pos.ok) return pos
  const ref = input.bankRef?.trim() ?? ''
  if (ref === '') {
    return input.requireBankRef ? fail('Deposit reference is required') : ok
  }
  if (!SHA256_HEX.test(ref)) {
    return fail('Deposit reference must be a sha256 digest (64 hex chars) — hash the bank record, never send it raw')
  }
  return ok
}

export function guardRedeemSubmit(input: IssueRedeemSubmitInput): GuardResult {
  if (!input.walletReady) return fail('Wallet not ready')
  if (input.assetId.trim() === '') return fail('Select an asset')
  const pos = guardPositiveAmount(input.amount)
  if (!pos.ok) return pos
  if (input.balance != null && input.amount > input.balance) {
    return fail('Amount exceeds available balance')
  }
  return ok
}

export interface RegisterSubmitInput {
  label: string
  ticker: string
  decimals: number
  walletReady: boolean
}

export function guardRegisterSubmit(input: RegisterSubmitInput): GuardResult {
  if (!input.walletReady) return fail('Wallet not ready')
  if (input.label.trim() === '') return fail('Label is required')
  if (!Number.isInteger(input.decimals) || input.decimals < 0) {
    return fail('Decimals must be a non-negative integer')
  }
  // ticker may be empty (issuer can fill later via metadata norms); no hard fail
  void input.ticker
  return ok
}

export interface AdminFieldSubmitInput {
  /** freeze / unfreeze / reissue source */
  outpoint?: string
  /** block / allow identity */
  identityKey?: string
  /** reissue recipient */
  recipient?: string
  requireOutpoint?: boolean
  requireIdentity?: boolean
  requireRecipient?: boolean
}

/** Compressed secp256k1 identity pubkey (33-byte hex, 02/03 prefix). */
export function guardIdentityKey(identityKey: string): GuardResult {
  const key = identityKey.trim()
  if (key === '') return fail('Identity key is required')
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(key)) {
    return fail('Identity key must be a compressed pubkey (66 hex chars, 02/03 prefix)')
  }
  return ok
}

/**
 * Recipient rail check for a Mandala token send (D4). Returns null when
 * `recipient` is a compressed identity key, otherwise the plain reason a
 * wallet's rail selector shows for "address unavailable". The reason is a
 * protocol fact, not a UI opinion: the token output key is ECDH-derived
 * against the recipient identity key (MandalaToken.lockBRC29), and the
 * overlay refuses a transaction carrying an FT output whose owner it cannot
 * name from a linkage — so a bare P2PKH address can never receive one.
 */
export function guardTokenRecipient(recipient: string): string | null {
  const key = recipient.trim()
  if (key === '') return 'Recipient identity key is required'
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(key)) {
    return 'Mandala tokens can only be sent to an identity key (66-hex compressed public key), not to an address — the token output is derived against the recipient identity and the overlay refuses anything else'
  }
  return null
}

/** Regulatory required fields — empty strings reject without starting a pipeline. */
export function guardAdminFields(input: AdminFieldSubmitInput): GuardResult {
  if (input.requireOutpoint && (input.outpoint == null || input.outpoint.trim() === '')) {
    return fail('Outpoint is required')
  }
  if (input.requireIdentity && (input.identityKey == null || input.identityKey.trim() === '')) {
    return fail('Identity key is required')
  }
  if (input.requireRecipient && (input.recipient == null || input.recipient.trim() === '')) {
    return fail('Recipient is required')
  }
  if (input.requireIdentity && input.identityKey != null && input.identityKey.trim() !== '') {
    return guardIdentityKey(input.identityKey)
  }
  return ok
}
