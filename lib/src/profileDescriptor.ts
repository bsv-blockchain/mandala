/**
 * The issuer-v1 descriptor reader shared by the `@bsv/mandala/profile`
 * handler and its hooks: params are exactly `{identityKey: K}` (C§4), K a
 * 66-hex lowercase compressed key on the curve. Every refusal is the
 * module's `ProfileParamsError` (D22, G12).
 */
import { PublicKey } from '@bsv/sdk'
import { StrictCborLink, type StrictCborValue } from '@bsv/templates'
import { ProfileParamsError, type ProfileDescriptor } from '@bsv/color-permission-module'

const KEY_RE = /^0[23][0-9a-f]{64}$/

export type CborMap = { readonly [key: string]: StrictCborValue }

/** A CBOR map as the strict decoder returns it: an object that is no array, bytes or link. */
export function isCborMap (v: unknown): v is CborMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    !(v instanceof Uint8Array) && !(v instanceof StrictCborLink)
}

/** True iff `map` has exactly the own members `members` (order-free). */
export function hasExactly (map: CborMap, members: readonly string[]): boolean {
  const keys = Object.keys(map)
  return keys.length === members.length && members.every(m => Object.prototype.hasOwnProperty.call(map, m))
}

/** 66 lowercase hex, compressed, on the curve, canonical. */
export function isIdentityKey (k: unknown): k is string {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false
  try {
    return PublicKey.fromString(k).toString() === k
  } catch {
    return false
  }
}

export const invalidProfile = (reason: string): ProfileParamsError =>
  new ProfileParamsError(`BRC-207: invalid Mandala issuer-v1 profile: ${reason}`)

/** issuer-v1 params: exactly `{identityKey: K}` (C§4). Returns K, else throws ProfileParamsError. */
export function issuerKey (descriptor: ProfileDescriptor): string {
  if (descriptor == null || typeof descriptor !== 'object') throw invalidProfile('descriptor must be {version, params}')
  if (descriptor.version !== 1) throw invalidProfile('version must be 1')
  const params = descriptor.params
  if (!isCborMap(params) || !hasExactly(params, ['identityKey'])) throw invalidProfile('params must be exactly {identityKey}')
  const k = params.identityKey
  if (!isIdentityKey(k)) throw invalidProfile('identityKey must be a lowercase compressed public key (66 hex) on the curve')
  return k
}
