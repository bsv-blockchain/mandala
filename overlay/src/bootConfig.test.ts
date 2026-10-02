import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OverlayExpress from '@bsv/overlay-express'
import { PrivateKey } from '@bsv/sdk'
import { readBootConfig, parseIssuerKeys, type BootConfig } from './bootConfig.js'

const KEY = '1'.repeat(64)
const K1 = PrivateKey.fromHex('66'.repeat(32)).toPublicKey().toString()
const K2 = PrivateKey.fromHex('44'.repeat(32)).toPublicKey().toString()
const base = { NODE_NAME: 'mandala', SERVER_PRIVATE_KEY: KEY, HOSTING_URL: 'http://localhost:8080', MONGO_URL: 'mongodb://m', NETWORK: 'test', MANDALA_ISSUER_KEYS: JSON.stringify([K1]) }
const TOKEN = 't'.repeat(32)

describe('readBootConfig', () => {
  it('local dev: http hosting URL yields a bare host, no arcade', () => {
    const c = readBootConfig(base)
    expect(c.advertisableHost).toBe('localhost:8080')
    expect(c.arcade).toBeUndefined()
    expect(c.sqliteFile).toBe('/data/overlay.sqlite')
  })
  it('https hosting URL is reduced to its host', () => {
    expect(readBootConfig({ ...base, HOSTING_URL: 'https://deggen.ngrok.app' }).advertisableHost).toBe('deggen.ngrok.app')
  })
  it('scheme-less hosting URL passes through', () => {
    expect(readBootConfig({ ...base, HOSTING_URL: 'overlay.example.com' }).advertisableHost).toBe('overlay.example.com')
  })
  it('rejects a bad NETWORK and a malformed key', () => {
    expect(() => readBootConfig({ ...base, NETWORK: 'ttn' })).toThrow(/NETWORK must be "main" or "test"/)
    expect(() => readBootConfig({ ...base, SERVER_PRIVATE_KEY: 'xyz' })).toThrow(/SERVER_PRIVATE_KEY must be an exact 32-byte/)
  })
  it('arcade requires a ≥32-byte callback token', () => {
    const env = { ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com' }
    expect(() => readBootConfig(env)).toThrow(/ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set/)
    expect(() => readBootConfig({ ...env, ARCADE_CALLBACK_TOKEN: 'short' })).toThrow(/ARCADE_CALLBACK_TOKEN must contain/)
  })
  it('arcade requires an https HOSTING_URL (Arcade calls back https://<host>/arc-ingest)', () => {
    expect(() => readBootConfig({ ...base, ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN }))
      .toThrow(/HOSTING_URL must be an https URL when ARCADE_URL is set/)
  })
  it('arcade defaults', () => {
    const c = readBootConfig({ ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN })
    expect(c.arcade).toEqual({
      url: 'https://arcade.example.com', apiKey: undefined, callbackToken: TOKEN,
      chaintracksUrl: 'https://arcade.example.com/chaintracks', chaintracksApiPrefix: '/v2', allowPrivateHosts: false
    })
  })
  it('weak ADMIN_API_TOKEN fails boot; unset stays open', () => {
    expect(readBootConfig(base).adminApiToken).toBe('')
    expect(() => readBootConfig({ ...base, ADMIN_API_TOKEN: 'short' })).toThrow(/ADMIN_API_TOKEN must contain/)
  })
})

describe('readBootConfig — edges', () => {
  const arcadeEnv = { ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN }

  it('returns the canonical key, the URL as given and the parsed scalars', () => {
    const c = readBootConfig({ ...base, SERVER_PRIVATE_KEY: 'AB'.repeat(32), SQLITE_FILE: '/tmp/x.sqlite', ADMIN_API_TOKEN: TOKEN })
    expect(c).toMatchObject({
      nodeName: 'mandala', serverPrivateKey: 'ab'.repeat(32), hostingUrl: 'http://localhost:8080',
      mongoUrl: 'mongodb://m', network: 'test', sqliteFile: '/tmp/x.sqlite', adminApiToken: TOKEN
    })
  })
  it.each(['NODE_NAME', 'SERVER_PRIVATE_KEY', 'HOSTING_URL', 'MONGO_URL', 'NETWORK'])('%s is required (unset and empty)', name => {
    expect(() => readBootConfig({ ...base, [name]: undefined })).toThrow(`Missing required environment variable: ${name}`)
    expect(() => readBootConfig({ ...base, [name]: '' })).toThrow(`Missing required environment variable: ${name}`)
  })
  it('an empty ARCADE_URL is "no arcade", not a half-configured one', () => {
    expect(readBootConfig({ ...base, ARCADE_URL: '' }).arcade).toBeUndefined()
  })
  it('a callback token without ARCADE_URL is ignored', () => {
    expect(readBootConfig({ ...base, ARCADE_CALLBACK_TOKEN: 'short' }).arcade).toBeUndefined()
  })
  it('a callback token with surrounding whitespace fails boot (a trailing newline from a secret store)', () => {
    expect(() => readBootConfig({ ...arcadeEnv, ARCADE_CALLBACK_TOKEN: TOKEN + '\n' })).toThrow(/^ARCADE_CALLBACK_TOKEN must not contain leading or trailing whitespace/)
  })
  it('arcade overrides: api key, chaintracks url and prefix, private hosts', () => {
    const c = readBootConfig({
      ...arcadeEnv, ARCADE_API_KEY: 'k', CHAINTRACKS_URL: 'https://ct.example.com/x',
      CHAINTRACKS_API_PREFIX: '/v3', ARCADE_ALLOW_PRIVATE_HOSTS: 'true'
    })
    expect(c.arcade).toEqual({
      url: 'https://arcade.example.com', apiKey: 'k', callbackToken: TOKEN,
      chaintracksUrl: 'https://ct.example.com/x', chaintracksApiPrefix: '/v3', allowPrivateHosts: true
    })
  })
  it('empty optional arcade variables fall back to their defaults', () => {
    const c = readBootConfig({ ...arcadeEnv, ARCADE_API_KEY: '', CHAINTRACKS_URL: '', CHAINTRACKS_API_PREFIX: '', ARCADE_ALLOW_PRIVATE_HOSTS: '' })
    expect(c.arcade).toEqual({
      url: 'https://arcade.example.com', apiKey: undefined, callbackToken: TOKEN,
      chaintracksUrl: 'https://arcade.example.com/chaintracks', chaintracksApiPrefix: '/v2', allowPrivateHosts: false
    })
  })
  it('an empty SQLITE_FILE falls back to the default', () => {
    expect(readBootConfig({ ...base, SQLITE_FILE: '' }).sqliteFile).toBe('/data/overlay.sqlite')
  })
  it('a malformed ARCADE_ALLOW_PRIVATE_HOSTS fails boot rather than reading as false', () => {
    expect(() => readBootConfig({ ...arcadeEnv, ARCADE_ALLOW_PRIVATE_HOSTS: 'maybe' })).toThrow(/ARCADE_ALLOW_PRIVATE_HOSTS must be one of/)
  })
  it('an unparseable HOSTING_URL names the variable instead of surfacing a bare "Invalid URL"', () => {
    expect(() => readBootConfig({ ...base, HOSTING_URL: 'http://' })).toThrow(/^HOSTING_URL must be a valid URL/)
  })
  // overlay-express 2.7.3 builds the Arcade callback as
  // `https://${advertisableFQDN}/arc-ingest` and refuses a raw value with a
  // path or credentials. Reducing such a URL to its host silently would
  // misroute every proof and eviction callback (Go keeps the path), so it
  // fails the boot instead — with or without Arcade, as upstream does.
  it.each([
    ['a path', 'https://h.example.com/overlay'],
    ['a trailing path segment', 'https://h.example.com/overlay/'],
    ['credentials', 'https://u:p@h.example.com'],
    ['a username only', 'https://u@h.example.com'],
    ['a query', 'https://h.example.com/?x=1'],
    ['a fragment', 'https://h.example.com/#top'],
    ['a path on an http URL', 'http://localhost:8080/overlay']
  ])('a HOSTING_URL with %s fails boot, with or without Arcade', (_label, url) => {
    expect(() => readBootConfig({ ...base, HOSTING_URL: url }))
      .toThrow('HOSTING_URL must be an origin (no path, query, fragment or credentials)')
    expect(() => readBootConfig({ ...arcadeEnv, HOSTING_URL: url }))
      .toThrow('HOSTING_URL must be an origin (no path, query, fragment or credentials)')
  })
  it('an origin with a bare trailing slash is still an origin', () => {
    expect(readBootConfig({ ...arcadeEnv, HOSTING_URL: 'https://h.example.com/' }).advertisableHost).toBe('h.example.com')
  })
  it('the https check reads the parsed scheme, so an upper-case HTTPS boots with Arcade', () => {
    const c = readBootConfig({ ...arcadeEnv, HOSTING_URL: 'HTTPS://O.Example.com' })
    expect(c.arcade).toBeDefined()
    expect(c.advertisableHost).toBe('o.example.com')
  })
  it('a bare host with Arcade is refused as not https, naming HOSTING_URL', () => {
    expect(() => readBootConfig({ ...arcadeEnv, HOSTING_URL: 'o.example.com' }))
      .toThrow(/^HOSTING_URL must be an https URL when ARCADE_URL is set/)
  })
  it('a weak ADMIN_API_TOKEN names the variable even when arcade is on', () => {
    expect(() => readBootConfig({ ...arcadeEnv, ADMIN_API_TOKEN: ' ' + TOKEN })).toThrow(/^ADMIN_API_TOKEN must not contain/)
  })
})

// What readBootConfig produces must be accepted by the REAL overlay-express
// 2.7.3 — it validates at configure time, so a bad shape would otherwise only
// show up as a boot crash in production. Mirrors the calls index.ts makes; no
// network is touched (nothing here starts the server).
describe('readBootConfig — accepted by the real OverlayExpress 2.7.3', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  const construct = (cfg: BootConfig): OverlayExpress =>
    new OverlayExpress(cfg.nodeName, cfg.serverPrivateKey, cfg.advertisableHost)
  const wireArcade = (server: OverlayExpress, a: NonNullable<BootConfig['arcade']>): void => {
    server.configureArcade(a.url, { apiKey: a.apiKey, allowPrivateHosts: a.allowPrivateHosts })
    server.configureArcCallbackToken(a.callbackToken)
    server.configureChaintracks(a.chaintracksUrl, { apiPrefix: a.chaintracksApiPrefix, allowPrivateHosts: a.allowPrivateHosts })
  }

  it('the HOSTING_URL as given is refused for an http URL; the derived host is not', () => {
    const cfg = readBootConfig(base)
    expect(() => new OverlayExpress(cfg.nodeName, cfg.serverPrivateKey, cfg.hostingUrl)).toThrow(/HTTPS host/)
    expect(() => construct(cfg)).not.toThrow()
  })

  it.each(['https://deggen.ngrok.app', 'https://o.example.com:8443', 'overlay.example.com', 'HTTPS://O.Example.com/'])('constructs for HOSTING_URL=%s', url => {
    expect(() => construct(readBootConfig({ ...base, HOSTING_URL: url }))).not.toThrow()
  })

  it('wires the default Arcade config', () => {
    const cfg = readBootConfig({ ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN, ARCADE_API_KEY: 'k' })
    expect(() => wireArcade(construct(cfg), cfg.arcade!)).not.toThrow()
  })

  it('a plain-http Arcade needs ARCADE_ALLOW_PRIVATE_HOSTS, and then it is accepted on both calls', () => {
    const env = { ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'http://arcade:3011', ARCADE_CALLBACK_TOKEN: TOKEN }
    const closed = readBootConfig(env)
    expect(() => wireArcade(construct(closed), closed.arcade!)).toThrow()
    const open = readBootConfig({ ...env, ARCADE_ALLOW_PRIVATE_HOSTS: 'true' })
    expect(() => wireArcade(construct(open), open.arcade!)).not.toThrow()
  })

  it('a callback token that passes readBootConfig always passes configureArcCallbackToken', () => {
    for (const token of ['t'.repeat(32), 'é'.repeat(16), 'a'.repeat(16384)]) {
      const cfg = readBootConfig({ ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: token })
      expect(() => construct(cfg).configureArcCallbackToken(cfg.arcade!.callbackToken)).not.toThrow()
    }
  })
})

describe('MANDALA_ISSUER_KEYS (spec §5.1)', () => {
  it('parses a JSON array of compressed keys', () => {
    expect(parseIssuerKeys(JSON.stringify([K1, K2]))).toEqual([K1, K2])
  })
  it.each([
    [undefined, /MANDALA_ISSUER_KEYS is required/],
    ['', /MANDALA_ISSUER_KEYS is required/],
    ['[]', /at least one/],
    ['not json', /JSON array/],
    ['{"a":1}', /JSON array/],
    [JSON.stringify([K1, K1]), /duplicate/],
    [JSON.stringify([K1.toUpperCase()]), /lowercase/],
    [JSON.stringify(['04' + 'ab'.repeat(64)]), /compressed/],
    [JSON.stringify(['02' + '00'.repeat(32)]), /not a valid public key/],
    [JSON.stringify([7]), /compressed/]
  ])('refuses %j', (raw, msg) => {
    expect(() => parseIssuerKeys(raw as string | undefined)).toThrow(msg)
  })
  it('readBootConfig exposes issuerKeys and fails boot without them', () => {
    expect(readBootConfig({ ...base, MANDALA_ISSUER_KEYS: JSON.stringify([K1]) }).issuerKeys).toEqual([K1])
    const { MANDALA_ISSUER_KEYS: _drop, ...without } = { ...base, MANDALA_ISSUER_KEYS: '' }
    expect(() => readBootConfig(without)).toThrow(/MANDALA_ISSUER_KEYS is required/)
  })
})
