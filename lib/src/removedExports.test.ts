/**
 * Contract removal list (C§8.1, Revision 3 / B7): the holder-side 'p mandala'
 * pipeline is gone from the package root. B7 restores the 0.4.1 hand-over
 * evidence (cover, collectHandoverEvidence) on the host side; the attested
 * companion profile is gone. The presence list pins
 * the 0.5.0 surface the consumer plans (05, 06, 07) import by name: a name
 * two modules both export would make `export *` drop it silently.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const mod: Record<string, unknown> = await import('./index.js')
const here = dirname(fileURLToPath(import.meta.url))

describe('removed exports', () => {
  it.each([
    'FT_PROTOCOL', 'BASKET', 'MAX_SAFE_AMOUNT', 'tokenTopic', 'tokenLookup', 'tokenTopicOrEmpty', 'isSigmaTopic',
    'deployTopics', 'decodeValue', 'lockToken', 'transferTokens', 'receiveTokens', 'defaultSettle',
    'canonicalBundleId', 'journalEvidenceSource', 'ATTESTED_PROFILE_ID', 'issuerAttestedLeaf', 'checkOfflineHops', 'encodeLinkagePayload', 'selectFtInputs',
    'loadFtCandidates', 'walletMandalaUnlock', 'formatAmountPlain', 'createMandalaProfile',
    // gone with the v2 hand-over evidence
    'derHex'
  ])('%s absent', n => {
    expect(n in mod).toBe(false)
  })

  // `./*` maps a subpath onto dist/<name>.js, so a removed subpath must have
  // no source file left to compile into one.
  it.each(['ftSelect', 'ftChange', 'ftCandidates', 'unlock', 'transfer', 'profileHopCheck'])('src/%s.ts is gone (no subpath)', n => {
    expect(() => readFileSync(resolve(here, `${n}.ts`))).toThrow()
  })

  // The core entry stays RN-safe: it never reaches the color module (D8).
  it('index.ts never re-exports a profile module or the color module', () => {
    const src = readFileSync(resolve(here, 'index.ts'), 'utf8')
    expect(src).not.toMatch(/from '\.\/profile/)
    expect(src).not.toMatch(/(?:from|import)\s*\(?\s*['"]@bsv\/color-permission-module/)
  })
})

describe('present exports (C§8.1)', () => {
  it.each([
    'TOPIC', 'LOOKUP', 'REGISTRY_TOPIC', 'REGISTRY_LOOKUP', 'MESSAGEBOX', 'MANDALA_PROFILE_ID',
    'TREASURY_BASKET', 'ADMIN_PROTOCOL', 'actionDescription', 'signAttestation', 'postLookup', 'LookupError',
    'fetchDeployTx', 'loadHistory', 'markHandoverDelivered', 'journalListHandovers', 'resubmitDelivered',
    'submitToOverlay', 'colorTopic', 'colorLookup', 'assetTag', 'colorProtocolID', 'colorBasket', 'configureMandala',
    'MAX_UINT64', 'formatAmount', 'parseAmount', 'mandalaReq', 'deployPayload', 'readDeploy', 'decodeToken',
    'attestationMessage', 'verifyAttestation', 'attestationFromSteak', 'admissionMessageV3', 'verifyAdmission',
    'payloadHash', 'fetchAdmission', 'encodeEnvelope', 'decodeEnvelope', 'recipientLinkage', 'planLabels',
    'sendHandover', 'deliverHandover', 'settleHandover', 'receiveHandovers', 'parseHandoverBody', 'registerAsset',
    'issueTokens', 'payoutTokens', 'redeemTokens', 'submitAdminAction', 'listAdminAssets', 'createMandalaClient',
    // also named by C§8.1 and the consumer plans
    'parseDecimalAmount', 'formatAmountGrouped', 'formatCurrency', 'InvalidTransferError', 'reconcileWallet',
    'reconcileNotifications',
    // B7 host-side evidence and settlement
    'cover', 'checkHop', 'collectHandoverEvidence', 'createHostLedger', 'buildHandoverEnvelope', 'settleReceipts',
    'acceptHandover', 'dismissHandover', 'handoverBody', 'receiptOfBody'
  ])('%s present', n => {
    expect(mod[n]).toBeDefined()
  })

  it('the constants carry their contract values', () => {
    expect(mod.TOPIC).toBe('tm_mandala')
    expect(mod.LOOKUP).toBe('ls_mandala')
    expect(mod.REGISTRY_TOPIC).toBe('tm_mandala_kyc')
    expect(mod.REGISTRY_LOOKUP).toBe('ls_mandala_kyc')
    expect(mod.MESSAGEBOX).toBe('mandala-color')
    expect(mod.MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
    expect(mod.TREASURY_BASKET).toBe('mandala treasury')
    expect(mod.ADMIN_PROTOCOL).toEqual([2, 'mandala admin'])
    expect(mod.MAX_UINT64).toBe(18446744073709551615n)
  })
})
