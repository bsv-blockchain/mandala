# @bsv/mandala

Issuer console and holder client for Mandala assets. Mandala tokens are plain
BRC-162 1Color tokens with uint64 amounts. The issuer treasury and the admin
chain stay under Mandala keys, and holder value moves only through BRC-207
receipts.

- **Issuer, admin and registry flows** (`register`, `issue`, `payout`,
  `redeem`, `admin`) spend Mandala-key outputs in the `mandala treasury`
  basket. Each one is overlay-first: the wallet signs with `noSend`, the
  overlay admits it on `/submit`, and only then does `sendWith` broadcast it.
  A journal covers every step, so `reconcile()` can recover after a crash.
- **Holder hand-overs** (`send`, `receive`) go through a BRC-100 wallet that
  hosts `@bsv/color-permission-module` 0.2.0 with the Mandala issuer-v1
  profile. The lib builds the recipient output and the BRC-207 plan. The
  wallet's color module adds the inputs, the token change and the Mandala
  envelope.
- **`@bsv/mandala/profile`** is the wallet side: the issuer-v1
  `RequiredProfileHandler` and the Mandala overlay provider. It is the only
  entry that imports the color module. The core entry is React Native safe.

All amounts are `bigint` base units in `0..2^64-1` (`MAX_UINT64`). JSON
carries them as canonical decimal strings. Use `parseAmount(text, decimals)`
and `formatAmount(units, decimals)` at the UI edge.

## Configure

```ts
import { createMandalaClient } from '@bsv/mandala'

const mandala = createMandalaClient({
  wallet,                                   // any BRC-100 WalletInterface; default: new WalletClient()
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: '02…',                // required for every submit and verify (fails closed when unset)
  messageBoxUrl: 'https://messagebox.example',
  storage                                   // MandalaStorage for the journals; required on React Native
})
```

`createMandalaClient` calls `configureMandala`, which is the single entry
point for endpoints and the journal storage adapter. The lib has no
environment defaults. Without an overlay identity key, every path that
submits to the overlay or verifies against it throws
`OVERLAY_IDENTITY_KEY_UNSET` before any wallet call.

## Issuer console

```ts
const { assetId } = await mandala.register({ label: 'Test Dollar', ticker: 'TUSD', decimals: 2 })
const [asset] = await mandala.assets()

await mandala.issue({ asset, amount: 100_000n, depositHash })          // mint into the treasury
const paid = await mandala.payout({ asset, amount: 2_500n, recipientKey }) // treasury → holder p color output + BRC-207 receipt
if (!paid.notified) { /* committed; the receipt is journaled and reconcileNotifications redelivers it */ }
await mandala.redeem({ asset, amount: 1_000n })

await mandala.admin({ asset, details: { kind: 'freezeOutput', outpoint } })
```

The deploy carries `req = mandalaReq(overlayIdentityKey)`, and its submit
topics are `['tm_mandala', 'tm_color_<txid>_0']`. A payout or a `reissue`
admin action creates the holder's output through `recipientLinkage` and
delivers the receipt on MessageBox `mandala-color`. Never re-run a payout
whose `notified` is `false`: the value has already moved.

## Holder send and receive (wallet host runtime, design B7)

Holder hand-overs run in the wallet HOST (the process that owns the
underlying wallet and the color module). The host builds one ledger and
shares it with the issuer-v1 handler and every lib call:

```ts
const ledger = createHostLedger(hostStorage)                    // in-process; never exposed over BRC-100
const mandala = createMandalaClient({ wallet: managerWallet, hostWallet: underlyingWallet, ledger,
  markSettled: txid => color.markSettled(txid), overlayUrl, overlayIdentityKey })

const { handover, notified, settle } = await mandala.send({ assetId, counterparty, amount: 400n, note: 'rent' })
// 1. sendHandover    sign plain noSend through the module; the host builds the envelope from its
//                    own custody, walks the evidence (σ / envelopes), records 'pending', journals 'signed'
// 2. deliverHandover MessageBox body v4 on 'mandala-color'; 'signed' → 'delivered'
// 3. settleHandover  after the ACK: submit on tm_color_<assetId>, verify σ, record settled, markSettled

const { accepted, failed } = await mandala.receive()           // own submit (online) or COVER (offline), record, internalize
await settleReceipts({ ledger, markSettled })                    // submit offline-credited chains once online
```

The v4 body carries the AtomicBEEF tip, the decimal amount, the receipt
fields (`derivationPrefix`, `derivationSuffix`, `senderIdentityKey` A or A′),
`admission` (σ of the tip), `admissions[]` (σ per admitted ancestor) and
`linkage[]` (the envelope of each unadmitted tx, the tip included). The
receipt the wallet internalizes is plain BRC-207 custody JSON.

Receive is online first: the recipient host submits the chain and needs a
verified σ covering its output. Only a transport failure takes the offline
path: COVER over `admissions[]` with the S1 hop checks (scripts verify,
conservation or a valid authority transition, 1 sat, one asset, envelope for
K, no duplicate spend). An offline credit is `pending` (`color_offline`)
until `settleReceipts` admits it. A typed verdict, retryable or not, is never
credited offline.

A delivery failure returns `notified: false`; the notification is journaled
and `reconcileNotifications` redelivers it. An undelivered hand-over is
never submitted by its sender. An unreadable inbox body is retried up to
`UNREADABLE_BUDGET` passes, then reported `exhausted` until
`dismissHandover`.

## Wallet registration (`@bsv/mandala/profile`)

```ts
import { createColorModule } from '@bsv/color-permission-module'
import { createMandalaProfile, MANDALA_PROFILE_ID } from '@bsv/mandala/profile'
import { createHostLedger } from '@bsv/mandala'

const ledger = createHostLedger(hostStorage)
const color = createColorModule({
  wallet: underlyingWallet, provider: defaultProvider, requestTokenAccess, store,
  profiles: { [MANDALA_PROFILE_ID]: createMandalaProfile({ overlays: [{ identityKey, url }], ledger }) }
})
new WalletPermissionsManager(underlyingWallet, adminOriginator, { permissionModules: { color } })
```

The handler credits a receipt only from the host ledger (`settled` or
`pending`), else it submits the receipt itself and requires σ. Its provider
answers `spendability` from the ledger when the overlay is unreachable or
has not admitted yet, so offline and chained hand-overs work.
`@bsv/color-permission-module` is an optional peer: only
`@bsv/mandala/profile` needs it.

## Recovery

`reconcile()` rebroadcasts overlay-accepted txs, re-submits retryable
refusals and delivered hand-overs, aborts dead noSend actions, and parks a
tx whose broadcast keeps failing as `stranded`. Its bulk sweep of stuck
noSend actions waits while any accepted, retryable, signed or delivered
entry exists. A host that manages its own noSend actions passes
`{ sweep: false }`. `reconcileNotifications(messageBoxClient)` redelivers
journaled hand-over and receipt notifications.

## Subpaths

Retained building blocks also resolve as subpaths through the `./*` export
map, for example `@bsv/mandala/history` (`loadHistory(wallet, { scope })`),
`metadata`, `adminState`, `adminHistory`, `overlayActivity`, `banking`,
`submitGuards`, `singleFlight`, `adminAuthGate`, `contacts`,
`contactsStore`, `registry`, `reconcile`, `notifyJournal`, `feeRate`,
`assetRecover` and `assets`.

## Vendored dependencies

Until the upstream packages are published, `@bsv/sdk` 4.0.0 and
`@bsv/templates` 2.2.0 (plus `@bsv/color-permission-module` 0.2.0 and
`@bsv/wallet-toolbox-client` for the profile entry and its tests) come from
tarballs in `../vendor-ts-stack/`. They are `devDependencies` with
`file:` specs, and `overrides` (`"<name>": "$<name>"`) pin every transitive
user to the same tarball. Consumers list the same tarballs as direct
dependencies with matching overrides. Once the packages are published, the
`file:` specs become registry ranges and the overrides go away. The
`peerDependencies` (`@bsv/sdk ^4.0.0`, `@bsv/templates ^2.2.0`,
`@bsv/message-box-client ^2.5.4`, optional
`@bsv/color-permission-module ^0.2.0`) already carry the published ranges.

## Breaking changes in 0.5.0

- Tokens are BRC-162 1Color (`OneColor`). The topics are
  `tm_color_<assetId>` and `ls_color_<assetId>`, and the registry keeps
  `tm_mandala`, `ls_mandala`, `tm_mandala_kyc` and `ls_mandala_kyc`. The
  `tm_<txid>` topics and σI v3 on token topics are gone. The overlay signs
  admission with the `1color-admit:v1` statement (`verifyAttestation`). The
  deploy `req` names only the issuer-v1 profile (B7).
- Amounts are `bigint` everywhere: APIs, stores and wire fields. JSON reads
  accept canonical decimal strings only. `MAX_SAFE_AMOUNT` and every 2^53
  path are gone.
- The holder-side `'p mandala'` pipeline is removed: `transferTokens`,
  `receiveTokens`, `defaultSettle`, `canonicalBundleId`,
  `journalEvidenceSource`, `lockToken`,
  `decodeValue`, `encodeLinkagePayload` (now `encodeEnvelope`), the
  `mandala-tokens` basket, `FT_PROTOCOL` and `BASKET`, and the `ftSelect`,
  `ftChange`, `ftCandidates` and `unlock` subpaths. Holders send with
  `sendHandover` (or `client.send`) and receive with `receiveHandovers` (or
  `client.receive`).
- Treasury, authority, deploy, registry and payout-change outputs derive
  under `ADMIN_PROTOCOL [2, 'mandala admin']` in the `mandala treasury`
  basket.
- MessageBox `mandala-payments` and the v1-v3 bodies are gone. Hand-overs
  and issuer receipts use `mandala-color` with the v4 body (B7); `cover` and
  `collectHandoverEvidence` return host-side with the S1 hop checks.
- The journal stage `handed_over` is replaced by `signed` (not delivered:
  never submitted, aborted or swept) and `delivered` (acknowledged:
  reconcile re-submits it).
- `loadHistory(wallet, { scope, assetId })` takes an options bag and also
  returns holder `transfer` and `receive` rows.
- `formatAmount` is exact plain decimal with no grouping.
  `formatAmountPlain` is removed, and `formatAmountGrouped` and
  `formatCurrency` take `bigint`.

No migration: old derivations, baskets, bodies and topics are refused, not
converted.
