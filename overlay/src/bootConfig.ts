import { PublicKey } from '@bsv/sdk'
import { canonicalPrivateKey, readBooleanEnv, readOptionalSecretEnv } from './secrets.js'

export interface BootConfig {
  nodeName: string
  serverPrivateKey: string // canonical 64-hex
  hostingUrl: string // as given (CORS origin, logs)
  advertisableHost: string // passed to new OverlayExpress(...)
  mongoUrl: string
  network: 'main' | 'test'
  sqliteFile: string
  adminApiToken: string // '' = open (dev default, warned)
  issuerKeys: readonly string[] // canonical lowercase compressed keys, input order, non-empty
  arcade?: {
    url: string
    apiKey?: string
    callbackToken: string // ≥32 bytes, mandatory with arcade
    chaintracksUrl: string
    chaintracksApiPrefix: string // default '/v2'
    allowPrivateHosts: boolean // ARCADE_ALLOW_PRIVATE_HOSTS, default false
  }
}

type Env = Record<string, string | undefined>

/**
 * MANDALA_ISSUER_KEYS (spec §5.1): the trusted-issuer set, a JSON array of
 * compressed identity keys in canonical lowercase hex. The package refuses a
 * non-canonical set at construction; failing here names the env var instead.
 */
export const parseIssuerKeys = (raw: string | undefined): string[] => {
  if (raw == null || raw.trim() === '') throw new Error('MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys') }
  if (!Array.isArray(parsed)) throw new Error('MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys')
  if (parsed.length === 0) throw new Error('MANDALA_ISSUER_KEYS must name at least one issuer key')
  const seen = new Set<string>()
  for (const [i, k] of parsed.entries()) {
    if (typeof k !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(k)) throw new Error(`MANDALA_ISSUER_KEYS[${i}] is not a compressed public key (02/03 + 64 hex)`)
    if (k !== k.toLowerCase()) throw new Error(`MANDALA_ISSUER_KEYS[${i}] must be lowercase hex`)
    try { PublicKey.fromString(k) } catch { throw new Error(`MANDALA_ISSUER_KEYS[${i}] is not a valid public key`) }
    if (seen.has(k)) throw new Error(`MANDALA_ISSUER_KEYS[${i}] is a duplicate`)
    seen.add(k)
  }
  return [...seen]
}

const requireEnv = (env: Env, name: string): string => {
  const v = env[name]
  if (v == null || v === '') throw new Error(`Missing required environment variable: ${name}`)
  return v
}

/** An empty value (`NAME=` in a compose file or .env) is unset, exactly like an absent one. */
const optionalEnv = (env: Env, name: string): string | undefined => {
  const v = env[name]
  return v == null || v === '' ? undefined : v
}

/**
 * overlay-express 2.7.3 wants a bare HTTPS host (it rejects http:// URLs and
 * paths), so a HOSTING_URL with a scheme is reduced to its host here — but only
 * when it IS an origin. overlay-express builds the Arcade callback as
 * `https://${advertisableFQDN}/arc-ingest` and refuses a raw value carrying a
 * path or credentials ("Advertisable FQDN must be an HTTPS host without
 * credentials or a path"); cutting such a URL down to its host would bypass
 * that fail-closed check and send every proof and eviction callback to the
 * bare host, where nothing is mounted behind a path-routed proxy (overlay-go,
 * which keeps the path, would call back somewhere else). So anything beyond an
 * origin fails the boot, with or without Arcade, as upstream does.
 */
export const advertisableHostOf = (hostingUrl: string): string => {
  if (!hostingUrl.includes('://')) return hostingUrl
  let url: URL
  try {
    url = new URL(hostingUrl)
  } catch {
    throw new Error('HOSTING_URL must be a valid URL or a bare host')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new Error('HOSTING_URL must be an origin (no path, query, fragment or credentials)')
  }
  return url.host
}

/** True only for an https URL; the scheme is read from the parsed URL, so case does not matter. */
const isHttpsUrl = (hostingUrl: string): boolean => {
  if (!hostingUrl.includes('://')) return false
  try {
    return new URL(hostingUrl).protocol === 'https:'
  } catch {
    return false
  }
}

export const readBootConfig = (env: Env): BootConfig => {
  const nodeName = requireEnv(env, 'NODE_NAME')
  const serverPrivateKey = canonicalPrivateKey(requireEnv(env, 'SERVER_PRIVATE_KEY'), 'SERVER_PRIVATE_KEY')
  const hostingUrl = requireEnv(env, 'HOSTING_URL')
  const advertisableHost = advertisableHostOf(hostingUrl)
  const mongoUrl = requireEnv(env, 'MONGO_URL')
  const network = requireEnv(env, 'NETWORK')
  if (network !== 'main' && network !== 'test') throw new Error('NETWORK must be "main" or "test"')
  const issuerKeys = parseIssuerKeys(env.MANDALA_ISSUER_KEYS)
  const adminApiToken = readOptionalSecretEnv(env, 'ADMIN_API_TOKEN')
  const arcadeUrl = optionalEnv(env, 'ARCADE_URL')
  let arcade: BootConfig['arcade']
  if (arcadeUrl != null) {
    const callbackToken = readOptionalSecretEnv(env, 'ARCADE_CALLBACK_TOKEN')
    if (callbackToken === '') throw new Error('ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set (overlay-express 2.7.3 refuses to start without it)')
    if (!isHttpsUrl(hostingUrl)) throw new Error('HOSTING_URL must be an https URL when ARCADE_URL is set (Arcade calls back https://<host>/arc-ingest)')
    arcade = {
      url: arcadeUrl,
      apiKey: optionalEnv(env, 'ARCADE_API_KEY'),
      callbackToken,
      chaintracksUrl: optionalEnv(env, 'CHAINTRACKS_URL') ?? `${arcadeUrl}/chaintracks`,
      chaintracksApiPrefix: optionalEnv(env, 'CHAINTRACKS_API_PREFIX') ?? '/v2',
      allowPrivateHosts: readBooleanEnv(env, 'ARCADE_ALLOW_PRIVATE_HOSTS', false)
    }
  }
  return {
    nodeName, serverPrivateKey, hostingUrl, advertisableHost,
    mongoUrl, network, sqliteFile: optionalEnv(env, 'SQLITE_FILE') ?? '/data/overlay.sqlite', adminApiToken, issuerKeys, arcade
  }
}
