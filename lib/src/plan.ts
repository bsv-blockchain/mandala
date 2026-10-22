/**
 * BRC-207 module action plan, carried in ordinary `createAction` labels
 * (C§8.1, 0207:1165-1210).
 *
 * The plan is strict UTF-8 JSON, hex encoded and split into consecutive chunks
 * of at most 200 lowercase hex characters, one label per chunk:
 *
 *   p color plan <partIndex> <partCount> <hexChunk>
 *
 * The JSON is rebuilt in canonical member order before it is serialized, so
 * the caller's object order never changes the labels (the A.159 vector pins
 * the exact bytes) and members outside the plan are dropped (0207:1189 "no
 * other members"). `profileData` leaves are profile-defined: they are
 * serialized as given.
 *
 * Pure function: no I/O, no state, safe to call repeatedly (retry,
 * double-click, multi-tab all yield identical labels for the same plan).
 */
import { Utils } from '@bsv/sdk'

export interface ColorPlanV1 {
  version: 1
  assets: string[]
  ownedOutputs: Array<{
    outputIndex: number
    assetId: string
    derivationPrefix: string
    derivationSuffix: string
    senderIdentityKey: string
  }>
  operations: Array<{ assetId: string, operation: string }>
  inputPositions: []
  changePositions: []
  sighashTypes: []
  profileData?: Record<string, Record<string, unknown>>
}

/** Label prefix of every plan part (0207:1170). */
export const PLAN_LABEL_PREFIX = 'p color plan'
/** Hex characters per part; nonfinal parts carry exactly this many (0207:1176). */
export const PLAN_CHUNK_HEX = 200
/** Bound on the decoded plan JSON (0207:1182). */
export const PLAN_MAX_BYTES = 16 * 1024 * 1024

function requireArray (name: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new TypeError(`ColorPlanV1.${name} must be an array`)
  return v
}

/** Rebuild the plan in canonical member order (0207 A.159 member order). */
function canonical (plan: ColorPlanV1): Record<string, unknown> {
  if (plan === null || typeof plan !== 'object') throw new TypeError('ColorPlanV1 must be an object')
  if (plan.version !== 1) throw new TypeError('ColorPlanV1.version must be 1')
  const assets = requireArray('assets', plan.assets)
  if (assets.length === 0) throw new TypeError('ColorPlanV1.assets must not be empty')
  if (assets.some(a => typeof a !== 'string')) throw new TypeError('ColorPlanV1.assets must be strings')
  if (new Set(assets).size !== assets.length) throw new TypeError('ColorPlanV1.assets must be unique')
  const ownedOutputs = requireArray('ownedOutputs', plan.ownedOutputs) as ColorPlanV1['ownedOutputs']
  const operations = requireArray('operations', plan.operations) as ColorPlanV1['operations']
  const out: Record<string, unknown> = {
    version: 1,
    assets: [...assets],
    ownedOutputs: ownedOutputs.map(o => ({
      outputIndex: o.outputIndex,
      assetId: o.assetId,
      derivationPrefix: o.derivationPrefix,
      derivationSuffix: o.derivationSuffix,
      senderIdentityKey: o.senderIdentityKey
    })),
    operations: operations.map(o => ({ assetId: o.assetId, operation: o.operation })),
    inputPositions: requireArray('inputPositions', plan.inputPositions),
    changePositions: requireArray('changePositions', plan.changePositions),
    sighashTypes: requireArray('sighashTypes', plan.sighashTypes)
  }
  if (plan.profileData !== undefined) out.profileData = plan.profileData
  return out
}

/**
 * Encode a plan as `p color plan <i> <n> <chunk>` labels (0207:1165-1186).
 * Throws `TypeError` on a non-v1 plan, empty or duplicate `assets`, a missing
 * array member, or a plan over {@link PLAN_MAX_BYTES} of decoded JSON.
 */
export function planLabels (plan: ColorPlanV1): string[] {
  const json = JSON.stringify(canonical(plan))
  // Every UTF-16 code unit encodes to at least one UTF-8 byte: reject before
  // allocating the byte array when the string alone is already over bound.
  // JSON.stringify escapes lone surrogates, so the UTF-8 is always well formed.
  const bytes = json.length > PLAN_MAX_BYTES ? null : Utils.toArray(json, 'utf8')
  if (bytes === null || bytes.length > PLAN_MAX_BYTES) {
    const size = bytes === null ? `at least ${json.length}` : String(bytes.length)
    throw new TypeError(`ColorPlanV1 is ${size} bytes, over the ${PLAN_MAX_BYTES}-byte plan bound`)
  }
  const hex = Utils.toHex(bytes)
  const n = Math.ceil(hex.length / PLAN_CHUNK_HEX)
  const labels: string[] = []
  for (let i = 0; i < n; i++) {
    labels.push(`${PLAN_LABEL_PREFIX} ${i} ${n} ${hex.slice(i * PLAN_CHUNK_HEX, (i + 1) * PLAN_CHUNK_HEX)}`)
  }
  return labels
}
