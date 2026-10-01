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

/** overlay-express 2.7.3 wants a bare HTTPS host (it rejects http:// URLs and paths). */
export const advertisableHostOf = (hostingUrl: string): string => {
  if (!hostingUrl.includes('://')) return hostingUrl
  try {
    return new URL(hostingUrl).host
  } catch {
    throw new Error('HOSTING_URL must be a valid URL or a bare host')
  }
}

export const readBootConfig = (env: Env): BootConfig => {
  const nodeName = requireEnv(env, 'NODE_NAME')
  const serverPrivateKey = canonicalPrivateKey(requireEnv(env, 'SERVER_PRIVATE_KEY'), 'SERVER_PRIVATE_KEY')
  const hostingUrl = requireEnv(env, 'HOSTING_URL')
  const mongoUrl = requireEnv(env, 'MONGO_URL')
  const network = requireEnv(env, 'NETWORK')
  if (network !== 'main' && network !== 'test') throw new Error('NETWORK must be "main" or "test"')
  const adminApiToken = readOptionalSecretEnv(env, 'ADMIN_API_TOKEN')
  const arcadeUrl = optionalEnv(env, 'ARCADE_URL')
  let arcade: BootConfig['arcade']
  if (arcadeUrl != null) {
    const callbackToken = readOptionalSecretEnv(env, 'ARCADE_CALLBACK_TOKEN')
    if (callbackToken === '') throw new Error('ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set (overlay-express 2.7.3 refuses to start without it)')
    if (!hostingUrl.startsWith('https://')) throw new Error('HOSTING_URL must be an https URL when ARCADE_URL is set (Arcade calls back https://<host>/arc-ingest)')
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
    nodeName, serverPrivateKey, hostingUrl, advertisableHost: advertisableHostOf(hostingUrl),
    mongoUrl, network, sqliteFile: optionalEnv(env, 'SQLITE_FILE') ?? '/data/overlay.sqlite', adminApiToken, arcade
  }
}
