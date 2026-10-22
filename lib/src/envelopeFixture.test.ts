/**
 * ENVELOPE seam fixture (C§10 must-pass; plan 04 Task 22, Review Focus 7).
 *
 * `__fixtures__/1color-envelope.json` freezes four lib-built transactions that
 * link by txid: deploy → issue → payout (issuer FakeWallet, overlay-first,
 * attested) → a holder hand-over built by `@bsv/color-permission-module`
 * 0.2.0 with the issuer-v1 handler (blinded recipient output 0, owned change
 * output 1). Plan 03 copies the file byte for byte to
 * `overlay-go/internal/mandala/testdata/1color-envelope.json` and replays it
 * through its engine flow (`TestTSEnvelopeAdmitted`, hand-over
 * `outputsToAdmit [0,1]`).
 *
 * This test checks the file against itself and against the overlay's
 * linkage.go rule, so a TS envelope that overlay-go would read differently
 * (member shapes, protocolID tuple, the `specific linkage revelation 2 …`
 * encryption, the G9 owner counterparty) fails here first. Regenerate only
 * when the C§5 envelope format changes (see `profile.integration.test.ts`,
 * MANDALA_REGEN_ENVELOPE), and report every regeneration to P-GO.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LockingScript, PrivateKey, ProtoWallet, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { decodeEnvelope, type SpecificLinkage } from './encoding.js'
import { decodeToken, readDeploy } from './brc162.js'
import { colorTopic } from './naming.js'
import { outputPubKeyHash, outputPublicKey } from './blinding.js'
import { checkOfflineHops } from './profileHopCheck.js'
import { MAX_UINT64 } from './amount.js'

interface FixtureTx {
  name: 'deploy' | 'issue' | 'payout' | 'handover'
  txid: string
  topics: string[]
  rawTxHex: string
  atomicBeefHex: string
  offChainValuesHex: string
  outputsToAdmit: Record<string, number[]>
}
interface Fixture {
  version: 1
  keys: { issuer: string, holder: string, recipient: string, overlay: string }
  privateKeys: { issuer: number, holder: number, recipient: number, overlay: number }
  assetId: string
  amounts: { issue: string, payout: string, handover: string, handoverChange: string }
  txs: FixtureTx[]
}

const FILE = fileURLToPath(new URL('./__fixtures__/1color-envelope.json', import.meta.url))
const HEX = /^(?:[0-9a-f]{2})*$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

const F: Fixture = JSON.parse(readFileSync(FILE, 'utf8'))
const tx = (name: FixtureTx['name']): FixtureTx => {
  const t = F.txs.find(x => x.name === name)
  if (t == null) throw new Error(`fixture has no ${name} tx`)
  return t
}
const parsed = (t: FixtureTx): Transaction => Transaction.fromAtomicBEEF(Utils.toArray(t.atomicBeefHex, 'hex'))
const envelopeOf = (t: FixtureTx): ReturnType<typeof decodeEnvelope> => decodeEnvelope(Utils.toArray(t.offChainValuesHex, 'hex'))
const inputSources = (t: Transaction): string[] =>
  t.inputs.map(i => `${i.sourceTXID ?? i.sourceTransaction!.id('hex')}.${i.sourceOutputIndex}`)

/** overlay-go linkage.go: K decrypts L; hash160(counterparty + L·G) must equal the output's P2PKH hash. */
async function linkageDerives (l: SpecificLinkage, lockingScriptHex: string): Promise<boolean> {
  const K = new ProtoWallet(new PrivateKey(F.privateKeys.overlay))
  const { plaintext: L } = await K.decrypt({
    ciphertext: l.encryptedLinkage,
    protocolID: [2, `specific linkage revelation 2 ${l.protocolID[1]}`],
    keyID: l.keyID,
    counterparty: l.prover
  })
  const pkh = OneColor.decode(LockingScript.fromHex(lockingScriptHex)).restPubKeyHash
  const derived = outputPubKeyHash(outputPublicKey(PublicKey.fromString(l.counterparty), L))
  return pkh != null && Utils.toHex(pkh) === Utils.toHex(derived)
}

describe('envelope fixture is self-consistent', () => {
  it('has the fixed schema: deterministic keys, lowercase hex, decimal amounts, four named txs', () => {
    expect(F.version).toBe(1)
    expect(F.privateKeys).toEqual({ issuer: 1111, holder: 2222, recipient: 3333, overlay: 5555 })
    for (const [role, n] of Object.entries(F.privateKeys)) {
      expect(F.keys[role as keyof Fixture['keys']]).toBe(new PrivateKey(n).toPublicKey().toString())
    }
    expect(F.keys.overlay).toBe('02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046')
    expect(F.assetId).toMatch(/^[0-9a-f]{64}_0$/)
    expect(F.amounts).toEqual({ issue: '1500', payout: '1000', handover: '400', handoverChange: '600' })
    for (const v of Object.values(F.amounts)) expect(v).toMatch(DECIMAL)
    expect(F.txs.map(t => t.name)).toEqual(['deploy', 'issue', 'payout', 'handover'])
    for (const t of F.txs) {
      expect(t.txid).toMatch(/^[0-9a-f]{64}$/)
      for (const h of [t.rawTxHex, t.atomicBeefHex, t.offChainValuesHex]) expect(h).toMatch(HEX)
      expect(t.offChainValuesHex.length).toBeGreaterThan(0)
    }
  })

  it('each AtomicBEEF parses to its txid and raw bytes', () => {
    for (const t of F.txs) {
      const p = parsed(t)
      expect(p.id('hex')).toBe(t.txid)
      expect(p.toHex()).toBe(t.rawTxHex)
      expect(Utils.toHex(p.toAtomicBEEF())).toBe(t.atomicBeefHex)
    }
  })

  it('topics and admitted outputs are the Mandala submit shapes', () => {
    const topic = colorTopic(F.assetId)
    expect(F.assetId).toBe(`${tx('deploy').txid}_0`)
    expect(tx('deploy').topics).toEqual(['tm_mandala', topic])
    expect(tx('deploy').outputsToAdmit).toEqual({ tm_mandala: [0], [topic]: [0] })
    for (const n of ['issue', 'payout', 'handover'] as const) expect(tx(n).topics).toEqual([topic])
    expect(tx('handover').outputsToAdmit).toEqual({ [topic]: [0, 1] })
    expect(tx('payout').outputsToAdmit).toEqual({ [topic]: [0, 1] })
  })

  it('the chain links by txid: deploy → issue → payout → hand-over', () => {
    expect(inputSources(parsed(tx('issue')))).toContain(`${tx('deploy').txid}.0`)
    expect(inputSources(parsed(tx('payout'))).some(o => o.startsWith(`${tx('issue').txid}.`))).toBe(true)
    expect(inputSources(parsed(tx('handover')))[0]).toBe(`${tx('payout').txid}.0`)
  })

  it('every offChainValues decodes as a Mandala envelope', () => {
    for (const t of F.txs) expect(() => envelopeOf(t)).not.toThrow()
    expect(typeof envelopeOf(tx('deploy')).deploySig).toBe('string')
    expect(envelopeOf(tx('issue')).admin?.length).toBe(1)
  })

  it('the hand-over envelope: outputs [0, 1], real prover and recipient, G9 owner counterparty, no inputs', () => {
    const env = envelopeOf(tx('handover'))
    expect('inputs' in env).toBe(false)
    expect(env.outputs!.map(o => o.index)).toEqual([0, 1])
    const [recipient, change] = env.outputs!.map(o => o.linkage)
    // The real keys, although the receipt shows the blinded A′ (C§5.1).
    expect(recipient.prover).toBe(F.keys.holder)
    expect(recipient.counterparty).toBe(F.keys.recipient)
    expect(change.prover).toBe(F.keys.holder)
    expect(change.counterparty).toBe(F.keys.holder)
    for (const l of [recipient, change]) {
      expect(l.verifier).toBe(F.keys.overlay)
      expect(l.keyID).toBe('color')
      expect(l.proofType).toBe(0)
      expect(l.protocolID[0]).toBe(2)
      expect(l.protocolID[1]).toMatch(/^p color [0-9a-f]{64}v0 [0-9a-f]+ [0-9a-f]+$/)
    }
  })

  it('every hand-over and payout linkage derives its output key under K (linkage.go)', async () => {
    for (const n of ['payout', 'handover'] as const) {
      const t = parsed(tx(n))
      for (const { index, linkage } of envelopeOf(tx(n)).outputs!) {
        expect(await linkageDerives(linkage, t.outputs[index].lockingScript.toHex()), `${n} output ${index}`).toBe(true)
      }
    }
  })

  it('hand-over outputs are 400 and 600 of the asset with 1 sat each', () => {
    const t = parsed(tx('handover'))
    const tokens = t.outputs.map((o, i) => ({ d: decodeToken(o.lockingScript, t.id('hex'), i), sats: o.satoshis }))
      .filter(x => x.d != null)
    expect(tokens.map(x => [x.d!.assetId, x.d!.role, x.d!.amount, x.sats])).toEqual([
      [F.assetId, 'value', 400n, 1],
      [F.assetId, 'value', 600n, 1]
    ])
    expect(BigInt(F.amounts.handover) + BigInt(F.amounts.handoverChange)).toBe(BigInt(F.amounts.payout))
    expect(BigInt(F.amounts.issue)).toBeLessThanOrEqual(MAX_UINT64)
  })

  it('the hand-over hop passes the offline local hop checks with K', () => {
    const t = tx('handover')
    expect(() => checkOfflineHops({ assetId: F.assetId } as any, [{
      txid: t.txid, atomicBEEF: Utils.toArray(t.atomicBeefHex, 'hex'), offChainValues: Utils.toArray(t.offChainValuesHex, 'hex')
    }], F.keys.overlay)).not.toThrow()
  })

  it('the deploy names the overlay key in its req (F-REQ)', () => {
    const d = parsed(tx('deploy'))
    expect(readDeploy(d.outputs[0].lockingScript, d.id('hex'))?.mandalaKey).toBe(F.keys.overlay)
  })
})
