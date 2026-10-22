import { describe, it, expect } from 'vitest'
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import {
  ColorPlan,
  assetBasket,
  attestationMessage as moduleAttestationMessage,
  colorProtocolID as moduleColorProtocolID,
  colorTopic as moduleColorTopic,
  verifyAttestation as moduleVerifyAttestation
} from '@bsv/color-permission-module'
import { planLabels, type ColorPlanV1 } from './plan.js'
import { colorBasket, colorProtocolID, colorTopic } from './naming.js'
import { attestationMessage, verifyAttestation } from './attestation.js'
import { MANDALA_PROFILE_ID } from './constants.js'

/**
 * D8: the lib implements plan labels, naming and attestation verification
 * itself so the core never loads the color module. These must agree with the
 * module exactly: the module parses the lib's labels and verifies the same
 * attestations.
 */
const ID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
const ID_TXID = ID.slice(0, 64)
const TX = '05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931'
const SIGNER = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const LOW = '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH = '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
const MESSAGE = `1color-admit:v1:tm_color_${ID}:${TX}:0,2`
const PRIV = new PrivateKey(5555)
const OWNER = new PrivateKey(4242).toPublicKey().toString()
const PREFIX = 'q83vEjRWeJCrze8SNFZ4kA=='
const SUFFIX = 'AAECAwQFBgcICQoLDA0ODw=='

const utf8 = (s: string): number[] => Utils.toArray(s, 'utf8')
const att = (signature: string, extra: Partial<{ txid: string, outputs: number[], signer: string }> = {}) =>
  ({ txid: TX, outputs: [0, 2], signer: SIGNER, signature, ...extra })

async function signWith (data: number[], keyID: string): Promise<string> {
  const { signature } = await new ProtoWallet(PRIV).createSignature({
    data, protocolID: [2, 'color admission attestation'], keyID, counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

const OPS = [{ assetId: ID, operation: 'transfer' }]

/**
 * The plan in canonical member order (A.159). The module serializes the
 * caller's object as given; the lib always re-serializes canonically. So the
 * labels are byte-equal for a canonically ordered plan, and for any order the
 * module decodes the lib's labels back to the same plan.
 */
function canonicalPlan (ownedOutputs: ColorPlanV1['ownedOutputs'], profileData?: ColorPlanV1['profileData']): ColorPlanV1 {
  return {
    version: 1,
    assets: [ID],
    ownedOutputs,
    operations: OPS,
    inputPositions: [],
    changePositions: [],
    sighashTypes: [],
    ...(profileData != null ? { profileData } : {})
  }
}

/** sendHandover's own member order (handover.ts: base spread, then ownedOutputs/profileData). */
function handoverOrdered (p: ColorPlanV1): ColorPlanV1 {
  const { ownedOutputs, profileData } = p
  return {
    version: 1, assets: p.assets, operations: p.operations, inputPositions: [], changePositions: [], sighashTypes: [],
    ownedOutputs,
    ...(profileData != null ? { profileData } : {})
  }
}

describe('lib ⇔ color module parity (D8)', () => {
  it('planLabels equals ColorPlan.toLabels for a recipient sendHandover plan (profileData leaf)', () => {
    const plan = canonicalPlan([], {
      [MANDALA_PROFILE_ID]: {
        [ID]: { outputs: [{ index: 0, linkage: { prover: OWNER, counterparty: SIGNER, protocolID: [2, 'p color x'], keyID: 'color', encryptedLinkage: 'AAEC', encryptedLinkageProof: 'AwQF' } }] }
      }
    })
    const lib = planLabels(plan)
    expect(lib).toEqual(ColorPlan.toLabels(plan as any))
    expect(ColorPlan.fromLabels(lib)).toEqual(plan)
    // sendHandover's member order: the same lib labels, and the module decodes them to the same plan
    expect(planLabels(handoverOrdered(plan))).toEqual(lib)
    expect(ColorPlan.fromLabels(planLabels(handoverOrdered(plan)))).toEqual(handoverOrdered(plan))
  })

  it('planLabels equals ColorPlan.toLabels for a self-send sendHandover plan (ownedOutputs)', () => {
    const plan = canonicalPlan([{ outputIndex: 0, assetId: ID, derivationPrefix: PREFIX, derivationSuffix: SUFFIX, senderIdentityKey: OWNER }])
    const lib = planLabels(plan)
    expect(lib).toEqual(ColorPlan.toLabels(plan as any))
    expect(ColorPlan.fromLabels(lib)).toEqual(plan)
    expect(planLabels(handoverOrdered(plan))).toEqual(lib)
    expect(ColorPlan.fromLabels(planLabels(handoverOrdered(plan)))).toEqual(handoverOrdered(plan))
  })

  it('a plan large enough to span several labels encodes identically', () => {
    const plan = canonicalPlan(Array.from({ length: 6 }, (_, i) => ({
      outputIndex: i, assetId: ID, derivationPrefix: PREFIX, derivationSuffix: SUFFIX, senderIdentityKey: OWNER
    })))
    const lib = planLabels(plan)
    expect(lib.length).toBeGreaterThan(1)
    expect(lib).toEqual(ColorPlan.toLabels(plan as any))
  })

  it('colorProtocolID, colorBasket and colorTopic equal the module\'s', () => {
    expect(colorProtocolID(ID, PREFIX, SUFFIX)).toEqual(moduleColorProtocolID(ID, PREFIX, SUFFIX))
    expect(colorBasket(ID)).toBe(assetBasket(ID, 'value'))
    expect(colorBasket(ID, 'authority')).toBe(assetBasket(ID, 'authority'))
    expect(colorTopic(ID)).toBe(moduleColorTopic(ID))
    expect(colorTopic(`${ID_TXID}_7`)).toBe(moduleColorTopic(`${ID_TXID}_7`))
  })

  it('attestationMessage equals the module\'s (C§3)', () => {
    expect(attestationMessage(ID, TX, [0, 2])).toBe(MESSAGE)
    expect(moduleAttestationMessage(ID, TX, [0, 2])).toBe(MESSAGE)
  })

  it('lib and module verifyAttestation agree on the C.0 LOW/HIGH and the six negatives', async () => {
    const both = (a: ReturnType<typeof att>, assetId = ID): [boolean, boolean] =>
      [verifyAttestation(a, assetId, SIGNER), moduleVerifyAttestation(a, assetId)]
    expect(both(att(LOW))).toEqual([true, true])
    expect(both(att(HIGH))).toEqual([true, true])
    // reordered outputs, missing index 2, other topic
    expect(both(att(LOW, { outputs: [2, 0] }))).toEqual([false, false])
    expect(both(att(LOW, { outputs: [0] }))).toEqual([false, false])
    expect(both(att(LOW), `${ID_TXID}_1`)).toEqual([false, false])
    // keyID '2', trailing newline, bare-key signature
    expect(both(att(await signWith(utf8(MESSAGE), '2')))).toEqual([false, false])
    expect(both(att(await signWith(utf8(MESSAGE + '\n'), '1')))).toEqual([false, false])
    expect(both(att(PRIV.sign(utf8(MESSAGE)).toDER('hex') as string))).toEqual([false, false])
  })
})
