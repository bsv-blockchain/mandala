/**
 * Contract removal list (C§8.1): the holder-side 'p mandala' pipeline and
 * cover() are gone from the package root. Holder value moves only through
 * BRC-207 receipts; the lib credits nothing itself. The presence list pins
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
    'deployTopics', 'decodeValue', 'lockToken', 'transferTokens', 'receiveTokens', 'defaultSettle', 'cover',
    'canonicalBundleId', 'collectHandoverEvidence', 'journalEvidenceSource', 'encodeLinkagePayload', 'selectFtInputs',
    'loadFtCandidates', 'walletMandalaUnlock', 'formatAmountPlain', 'createMandalaProfile',
    // gone with the v2 hand-over evidence
    'derHex'
  ])('%s absent', n => {
    expect(n in mod).toBe(false)
  })

  // `./*` maps a subpath onto dist/<name>.js, so a removed subpath must have
  // no source file left to compile into one.
  it.each(['ftSelect', 'ftChange', 'ftCandidates', 'unlock', 'transfer', 'bundle'])('src/%s.ts is gone (no subpath)', n => {
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
    'TOPIC', 'LOOKUP', 'REGISTRY_TOPIC', 'REGISTRY_LOOKUP', 'MESSAGEBOX', 'ATTESTED_PROFILE_ID', 'MANDALA_PROFILE_ID',
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
    'reconcileNotifications'
  ])('%s present', n => {
    expect(mod[n]).toBeDefined()
  })

  it('the constants carry their contract values', () => {
    expect(mod.TOPIC).toBe('tm_mandala')
    expect(mod.LOOKUP).toBe('ls_mandala')
    expect(mod.REGISTRY_TOPIC).toBe('tm_mandala_kyc')
    expect(mod.REGISTRY_LOOKUP).toBe('ls_mandala_kyc')
    expect(mod.MESSAGEBOX).toBe('mandala-color')
    expect(mod.ATTESTED_PROFILE_ID).toBe('https://brc.dev/207/attested')
    expect(mod.MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
    expect(mod.TREASURY_BASKET).toBe('mandala treasury')
    expect(mod.ADMIN_PROTOCOL).toEqual([2, 'mandala admin'])
    expect(mod.MAX_UINT64).toBe(18446744073709551615n)
  })
})
