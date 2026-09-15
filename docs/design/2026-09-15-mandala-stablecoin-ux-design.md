> Source: `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/design-final-ux.md` · Copied 2026-09-15. Spec of record; companions: `2026-09-15-mandala-offline-settlement-design.md`, `2026-09-15-mandala-wire-contract-v2.md`.

# Mandala stablecoins in bsv-wallet — final UX design

**Status:** 2026-09-15 — supersedes: payer-submits-before-handover; companion docs: 2026-09-15-mandala-offline-settlement-design.md, 2026-09-15-mandala-wire-contract-v2.md

**Name:** `final-ux` (built on `pay-first`, with the runners-up's best ideas grafted and every judged flaw fixed)
**Date:** 2026-09-14
**Scope:** holder flows (accept + transfer) in `@bsv/expo-wallet-toolbox`, consuming `@bsv/mandala`. Issuer/admin surfaces are out of scope (D1).

Path legend: `W/` = `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/`, `WR/` = `/Users/personal/git/bsv-wallet/`, `L/` = `/Users/personal/git/demos/mandala/lib/src/`.

Locked decisions D1–D4 are assumed and designed within, never re-argued.

---

## 1. Design principles

1. **The asset is a property of a payment, not a mode of the wallet** — it is chosen inside Pay and Get paid, beside the two questions those screens already ask (who, and how much), and nowhere else.
2. **A wallet that has never held a token renders today's screen** — every token surface is conditional on a fact being true, and the first fact is "you hold one".
3. **The BSV figure keeps the one display-size slot because it is the fee balance, and it says so** — token outputs are 1 satoshi and fees come from the `default` basket (`W/core/storage/methods/walletBalanceSql.ts:35-36`, `StorageExpoSQLite.ts:1166-1171`), so demoting BSV would hide the number that gates every token send; the moment a token is held the hero's label changes from "You have" to "Your BSV" so the layout cannot be misread.
4. **Never print a number the wallet cannot stand behind** — no decimal point inserted on a guessed `decimals`, no fiat equivalent for a token, no satoshi figure on a token row, no sigil for a party we cannot name.
5. **State the guarantee separately from the guess** — every money failure leads with what provably did *not* happen ("Nothing was sent and your balance is unchanged", earned by `abortAction` at `L/overlay.ts:85-95`) and only then offers a narrowed reason, which is a hint.

---

## 2. Information architecture

No new route. No new `Stack.Screen`. One new sheet. Everything else is a prop or a slot in a screen that already exists.

| Surface | Form | Exists when | Job |
|---|---|---|---|
| Home pinned header (`W/ui/screens/WalletHomeScreen.tsx:1173-1242`) | unchanged geometry; one conditional label swap | always | BSV balance + Pay / Get paid / Vault |
| Home **Balances** block | `GroupedSection` + one `AssetRow` per asset, first child of `listHeader` (`:1244`) | `useTokenAssets()` non-empty **or** any `'mandala'`-labelled action in the loaded history | what you hold; tap → Asset sheet |
| **Asset sheet** | `Sheet fitContent` (`W/ui/components/ui/Sheet.tsx`) | on tap of a row | issuer, token id, the issuer's four powers, paused/frozen state, Pay / Get paid |
| Pay → **Paying with** | `AssetPicker` inside a `PayField`, **above** `RecipientField` | ≥1 asset held | BSV (default) or a token |
| Pay → amount / rails / CTA | existing `PayAmountField`, `RecipientField`, `PayCta` | always | re-denominated; address rail refused inline (D4) |
| Get paid → **Getting paid in** | same `AssetPicker`, above the amount | ≥1 asset held | request denomination |
| Get paid → methods | existing `RequestHub` `PayCellRow`s | always | address row disabled with a plain reason (D4) |
| Get paid → handle | existing `HandleReceive` | always | same QR; asset caption; `AdmissionNotice` replaces the plate when the issuer has not registered you |
| Activity | existing single `FlatList` | always | token rows interleaved, same row component |
| Success / arrival | existing `PaymentSuccessOverlay` | on send/receive | token-denominated; first-hold disclosure line |

**Hidden until relevant:** everything. `AssetRow`, `AssetPicker`, the Balances header and every token string return `null` when there is nothing held. There is no empty state, no "no tokens yet", no "add a token".

**Chain gate.** `isMandalaAvailable(chain) = chain === 'main' && toolboxConfig.services[chain]?.mandala != null` — the exact shape of `isVaultAvailable(chain) = isVaultEnabled() && chain === 'main'` (`W/core/toolboxConfig.ts:162-164`), because `L/metadata.ts:29,35` is mainnet-pinned (`networkPreset: 'mainnet'`, `WhatsOnChain('main')`). When it is false, `useTokenAssets` returns `[]` and every surface above is absent — not broken, absent. Every read is additionally gated on `storageMatchesNetwork(storage, selectedNetwork)` (invariant 10).

### 2.1 Home — holding one token

```
┌────────────────────────────────────────────────┐
│                                            (⚙) │
│                                                │
│                   Your BSV                     │ ◄ label swap: 'You have' →
│              54,195,449 sats                   │   'Your BSV' ONLY when a token
│             0.54195449 BSV · $9.33             │   is held. typography.display
│                                                │   (44/700) — UNCHANGED slot
│  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ │
│  │      ↗      │ │      ↙      │ │    ▣     │ │ UNCHANGED (Pay = the only
│  │     Pay     │ │  Get paid   │ │  Vault   │ │ accent fill on this screen)
│  └─────────────┘ └─────────────┘ └──────────┘ │
│ ═══ pinned above · list scrolls below ═══      │
│  BALANCES                                      │ ◄ NEW GroupedSection
│ ┌────────────────────────────────────────────┐ │
│ │ (▤)  Acme Dollar          1,240.00 USDX  › │ │  figure = typography.title3
│ └────────────────────────────────────────────┘ │  in ListRow's `trailing`
│                                                │
│  Activity                        [⤓ Export CSV]│
│  TODAY                                         │
│ ┌──┐                                           │
│ │◈ │ Sent USDX                  −25.00 USDX    │ ◄ token row: sigil (recipient
│ └──┘ ● Confirmed · 4:40 PM                     │   is NOT blinded), no 2nd line
│ ┌──┐                                           │
│ │↙ │ Received USDX             +40.00 USDX     │ ◄ token row: NO sigil (sender
│ └──┘ ● Confirmed · 2:11 PM                     │   is A′ — a fresh key each time)
│ ┌──┐                                           │
│ │◈ │ Payment to a nearby device  −6,745 sats   │ ◄ BSV row: unchanged
│ └──┘ ● Seen · 4:38 PM             < ($0.01)    │
└────────────────────────────────────────────────┘
```

A wallet that has never held a token renders this screen **without** the label swap, the BALANCES block and the token rows — i.e. byte-identical to `docs/wallet_home.png` today.

**Why the label swap.** The sharpest criticism of `pay-first` was that a holder with 1,240.00 USDX and no BSV reads "You have / 0 sats" at 44/700 with their real money in body text below. The fee-balance argument justifies keeping BSV *prominent*; it does not license letting the hero claim to be the answer to "how much money do I have". One conditional word — `t('wallet_balance_your_bsv')` in place of `t('wallet_balance_you_have')` at `WalletHomeScreen.tsx:1183` when `assets.length > 0` — removes the ambiguity entirely, adds no figure, breaks no invariant (still one `typography.display` element, `tokens.ts:52-58`), and costs nothing for the wallets that will never see it.

**Row states** (all through the existing `ListRow` props — no `ListRow` change):

| state | `icon` | `iconColor` | `subtitle` | `trailing` |
|---|---|---|---|---|
| normal | `cash-outline` | — (neutral `surfaceSunken` well) | — | `<AssetAmount size="row">` |
| first hold, sheet never opened | `cash-outline` | — | `t('token_new_tap')` | `<AssetAmount>` |
| paused | `pause-circle-outline` | `colors.warning` | `t('token_paused_short')` | `<AssetAmount>` |
| part frozen | `snow-outline` | `colors.warning` | `t('token_frozen_short', {amount})` | `<AssetAmount>` |
| balance unknown (`null`) | `cash-outline` | — | — | `<ActivityIndicator/>` |
| metadata unresolved | `help-circle-outline` | — | `t('token_unresolved_sub')` | **nothing** |

The figure lives in `trailing`, not `value`: `ListRow.value` is typed `string` and styled as a settings value (`W/ui/components/ui/ListRow.tsx:36`), and the money figure needs `typography.title3` + `fontVariant: ['tabular-nums']`.

`label` for the unresolved case is `t('token_unresolved')` = "Unrecognised token" — **not** a truncated hex id, and **no figure at all**. `L/metadata.ts:6,44` memoises `null` for the process lifetime, so this is a steady state, not a flicker; printing `1240000000 615a06ab…` in the money column would put protocol jargon where the amount goes and a number three orders of magnitude off beside it.

**Section footer.** The `GroupedSection` `footer` slot (`W/ui/components/ui/GroupedList.tsx`, `footer?: string`) carries `t('token_fee_footer')` — "Sending needs a little BSV for the network fee. Receiving doesn't." — **only when `useSpendableBalance()` is exactly `0`** (not `null`; see §4.2). One sentence, in the system's own explanatory-prose slot, present exactly when it is both true and actionable. No "fee balance" concept is invented anywhere.

### 2.2 Asset sheet

Raised by tapping a Balances row. Never auto-raised: `pay-first`'s automatic first-arrival sheet was unprompted modality on the most-used screen whose coverage depended on where the user happened to be standing. Disclosure instead lands in the two places the user is provably looking — the arrival overlay (§5.2) and the row's own "New — tap to see who issues it" subtitle, which clears once the sheet has been opened (persisted under `mandala_seen_assets`).

```
              ┌──────────── ▄▄▄ ─────────────┐
              │  Acme Dollar             ✕   │  Sheet title
              │                              │
              │        1,240.00 USDX         │  typography.title1, tabular-nums
              │       120.00 frozen          │  footnote/warning, only when > 0
              │                              │
              │  ┌────────────────────────┐  │
              │  │ Issued by    Acme Bank │  │  resolveIdentity, else
              │  │ Token ID    615a06ab…4 │  │  abbreviateKey; mono, tap copies
              │  └────────────────────────┘  │
              │                              │
              │  WHAT ACME BANK CAN DO       │
              │  ┌────────────────────────┐  │
              │  │ Pause all transfers    │  │  topic_manager.go:450-455
              │  │ of USDX                │  │
              │  │ Freeze specific coins, │  │  :440-449
              │  │ including yours        │  │
              │  │ Decide who may hold    │  │  Gate 3 + membershipHolds
              │  │ USDX                   │  │
              │  │ Replace a frozen coin  │  │  reissueGuardFails, :505-508
              │  │ with a new one         │  │
              │  └────────────────────────┘  │
              │  They can't move USDX out of │  GroupedSection footer
              │  your wallet without you,    │
              │  and a frozen coin simply    │
              │  can't be spent.             │
              │                              │
              │  ┌───────────┐┌────────────┐ │
              │  │  ↗  Pay   ││ ↙ Get paid │ │  Pay = accent; the one fill
              │  └───────────┘└────────────┘ │
              └──────────────────────────────┘

paused variant inserts above the powers group:
              │  ┌────────────────────────┐  │
              │  │ ⏸ Transfers paused     │  │  iconColor: colors.warning
              │  │   Acme Bank has paused │  │  Pay disabled; Get paid stays
              │  │   USDX transfers. You  │  │  enabled — refusing to receive
              │  │   can still be paid.   │  │  would be the wallet deciding
              │  └────────────────────────┘  │  on the issuer's behalf
```

Four powers, each a real gate in `overlay-go/internal/mandala/topic_manager.go`, stated as capability — not a category label, and **no "Verified" chip** (the web app hard-codes one at `SendTokens.tsx:741-744` that reflects nothing). If `resolveIdentity` returns a name and avatar, that *is* the badge and it was earned by data. No backing, peg or reserve copy anywhere: the wallet has no evidence for any of it.

### 2.3 Pay

```
 ‹                    Pay
────────────────────────────────────────────────
 PAYING WITH                                      ◄ NEW — absent when no assets
┌──────────────────────────────────────────────┐
│ (▤) Acme Dollar          1,240.00 USDX    ⌄  │
└──────────────────────────────────────────────┘
   ── expanded (tap the row) ──
┌──────────────────────────────────────────────┐
│ (₿) BSV                    54,195,449        │
│ (▤) Acme Dollar             1,240.00      ✓  │  checkmark in colors.accent
└──────────────────────────────────────────────┘

 RECIPIENT
┌──────────────────────────────────────────────┐
│  Name, @handle or key                 [ ⛶ ]  │
└──────────────────────────────────────────────┘
   🔑 Valid identity key

 AMOUNT
┌──────────────────────────────────────────────┐
│ 25.00                        USDX     [ Max ]│  decimal-pad, 2 dp
└──────────────────────────────────────────────┘
   1,120.00 available
   120.00 USDX of your balance is frozen and
   can't be sent.

 NOTE
┌──────────────────────────────────────────────┐
│ Add a note (optional)                        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│            ↑   Send 25.00 USDX               │  accent-filled
└──────────────────────────────────────────────┘
```

**Asset first, above the recipient**, because selecting an asset changes the unit of the amount, the available figure, and which recipient shapes are legal. Recipient-first would silently invalidate work the user already did.

The expander is the display-currency selector pattern from `W/ui/screens/WalletConfigScreen.tsx:492-527` verbatim — a `ListRow` with `chevronDown`, expanding to an inline list of rows with a trailing `checkmark`. Not `@react-native-segmented-control` (a declared-but-unused dependency that caps out at four options).

### 2.4 Get paid

```
 ‹                 Get paid
────────────────────────────────────────────────
 GETTING PAID IN                                  ◄ NEW, absent when no assets
┌──────────────────────────────────────────────┐
│ (▤) Acme Dollar                           ⌄  │
└──────────────────────────────────────────────┘

 AMOUNT
┌──────────────────────────────────────────────┐
│ 25.00                             USDX       │  no Max, no balance line
└──────────────────────────────────────────────┘

 HOW
┌──────────────────────────────────────────────┐
│ ⛶  Someone nearby                          › │
│    Show your payment code                    │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ ↗  Share remote link                       › │
│    Share your handle — they choose the amount│  ◄ subtitle swap: the link
└──────────────────────────────────────────────┘     carries no token figure
┌──────────────────────────────────────────────┐
│ ▭  To a BSV address                          │  opacity 0.4, unpressable
│    Not available for USDX                    │  (D4 — disabled with a plain
└──────────────────────────────────────────────┘   reason, NOT removed)
```

`RequestHub`'s address row uses `PayCellRow disabled` with its subtitle swapped — the exact mechanism it already uses for the offline case (`RequestHub.tsx:54-66`). D4 says "shows as unavailable with a plain reason"; removing the row would silently delete one of three rows the user has learned.

---

## 3. Component inventory

### 3.1 Shared types

```ts
// W/core/mandala/types.ts (new, ~40 lines)
export interface AmountAsset {
  assetId: string
  ticker: string                 // display unit; falls back to the label
  decimals: number               // ONLY present when resolved — see TokenAsset
}
export interface TokenAsset {
  assetId: string
  label: string                  // "Acme Dollar"; '' when unresolved
  ticker?: string                // "USDX"
  decimals?: number              // UNDEFINED = unresolved. NEVER coerced to 0.
  balance: number | null         // base units, total. null = UNKNOWN, never 0.
  frozenBaseUnits: number        // own frozen outputs only
  spendableBaseUnits: number | null   // balance - frozen
  issuerIdentityKey?: string
  issuerName?: string            // resolveIdentity, best-effort
  isPaused: boolean
  unresolved: boolean            // metadata lookup failed
}
/** Present only when `decimals` resolved; the only thing an amount field accepts. */
export function amountAssetOf(a: TokenAsset): AmountAsset | null
export const TOKEN_FEE_FLOOR_SATS = 200
```

`TOKEN_FEE_FLOOR_SATS = 200`, not 1000. A 1-input / 1-recipient / ≤8-change transfer at `{model:'sat/kb', value:100}` costs roughly 60–200 satoshis including the 1-satoshi outputs, so a 1000-satoshi floor hard-blocks users holding 200–999 satoshis who could send fine. The check is **advisory and never disables the CTA** (§4.2) — it changes copy, not capability.

### 3.2 NEW

| # | Path | Signature | What it is |
|---|---|---|---|
| 1 | `W/ui/hooks/useTokenAssets.ts` | `() => { assets: TokenAsset[] \| null; loading: boolean; refresh: () => void }` plus `expectTokenBalance(assetId, baseUnits)` | The balance hook. Copies `useVaultBalance.ts:41-179`'s contract exactly: module-level store + `useSyncExternalStore`, keyed to `managers.permissionsManager` so a wallet switch reads `null`, invalidated on `txStatusVersion`, `SETTLE_WINDOW_MS = 30_000` with 300ms→5s backoff, `null` means unknown and is never rendered as `0`, a failed read keeps the last figure. Gated on `isMandalaAvailable(selectedNetwork)` **and** `storageMatchesNetwork`. Reads: **one** `listOutputs({ basket: 'mandala-tokens', include: 'locking scripts', includeCustomInstructions: true, limit: 1000 })` (the lib's own limit; `listOutputs` is not in either `guardVaultAccess` set — `guard.ts:490` — so the 500 cap does not apply), then `decodeBalances` (`L/tokens.ts:10`), then `resolveAssetMetadata` per asset (memoised in-lib), then `resolveAssetState` **once per foreground** per held asset. `expectTokenBalance` is the sibling of `expectVaultBalance`: without it a send's own `txStatusVersion` bump races the change output and the row flickers back to the pre-send figure. |
| 2 | `W/ui/hooks/useTokenActivity.ts` | `(neededTxids: string[]) => Map<string, TokenActivity>` where `TokenActivity = { direction: 'sent'\|'received'\|'issued'\|'redeemed'; assetId: string; baseUnits: number }` | One `listActions({ labels:['mandala'], includeLabels, includeOutputs, includeOutputLockingScripts, limit: window })` + one `listOutputs({ basket, includeCustomInstructions, limit: 1000 })`, joined by outpoint and parsed by `parseActionsToHistory` (`L/history.ts`, exported, 19 tested classification cases). `window` starts at 100 and doubles to a 1000 cap **only** when `neededTxids` contains a txid outside the current result and the last page was full — so it terminates, and Home paginating past the window grows it instead of silently losing denomination. |
| 3 | `W/ui/hooks/useRegistryAdmission.ts` | `() => { selfStatus: AdmissionStatus; check(key: string): AdmissionStatus }` where `AdmissionStatus = 'unknown' \| 'not-required' \| 'admitted' \| 'not-admitted' \| 'revoked'` | `fetchRegistry()` + `registryIsLive(rows)` (`L/registry.ts:367,373`), 5-minute TTL, re-fetched on focus, **fails open to `'unknown'` on any ambiguity** — the Go overlay's `membershipHolds` and the TS overlay's `registryScreening` differ, and a wrong "not admitted" is worse than a missing one. |
| 4 | `W/ui/components/wallet/BalancesSection.tsx` | `{ assets: TokenAsset[]; showFeeFooter: boolean; onPress: (assetId: string) => void }` | `GroupedSection` header `t('token_balances_header')` + one `AssetRow` each + the conditional footer. Returns `null` when `assets.length === 0`. ~70 lines. |
| 5 | `W/ui/components/wallet/AssetRow.tsx` | `{ asset: TokenAsset; isNew: boolean; isLast: boolean; onPress: () => void }` | The state table in §2.1, rendered entirely through existing `ListRow` props. ~60 lines. |
| 6 | `W/ui/components/wallet/AssetAmount.tsx` | `{ baseUnits: number \| null; asset: TokenAsset; size?: 'row' \| 'sheet'; showPlus?: boolean; tone?: 'primary' \| 'incoming' }` | The token sibling of `AmountDisplay`. Renders `value` + `unit` as two `<Text>`s with `fontVariant: ['tabular-nums']`, one composed `accessibilityLabel`. Returns `<ActivityIndicator/>` for `null` and `null` for `asset.decimals === undefined`. ~50 lines. |
| 7 | `W/ui/components/wallet/AssetSheet.tsx` | `{ visible: boolean; asset: TokenAsset \| null; onClose: () => void; onPay: (id: string) => void; onGetPaid: (id: string) => void }` | §2.2. `Sheet fitContent`. ~180 lines. |
| 8 | `W/ui/components/pay/AssetPicker.tsx` | `{ assets: TokenAsset[]; selected: string \| null; onSelect: (id: string \| null) => void; bsvBalance: number \| null; labelKey: 'pay_asset_label' \| 'pay_asset_label_get'; needsBsv: boolean }` | The `WalletConfigScreen` expander pattern. `null` = BSV. Returns `null` when `assets.length === 0`. A token row whose `decimals` is unresolved is rendered `disabled`. ~120 lines. |
| 9 | `W/ui/components/pay/AdmissionNotice.tsx` | `{ ticker: string; issuerName: string; onBsvInstead: () => void }` | Replaces `HandleReceive`'s QR plate when `useRegistryAdmission().selfStatus` is `not-admitted`/`revoked`. §5.4. ~90 lines. |
| 10 | `W/core/pay/rails/token.ts` | `sendTokenViaHandle(args)`, `TokenRailWallet` (structural: the 13 `WalletInterface` methods the lib calls, §1 of the fact sheet) | The handle-rail token send. Wraps `transferTokens` with the wallet's originator and configured endpoints. |
| 11 | `W/core/pay/creditTokenInbox.ts` | `creditTokenInboxOnce({ wallet, adminOriginator, client, storage }) => Promise<{ accepted: ReceivedTransfer[]; failed: {...}[] }>` | Mutexed pass over the `'mandala-payments'` box wrapping `receiveTokens`, with a storage-persisted `processed` set. |
| 12 | `W/core/monitor/TaskCreditToken.ts` | sibling of `TaskCreditInbox` | Same statics, `BASE_BACKOFF_MS = 10_000` → `MAX_BACKOFF_MS = 300_000`, `onlineNow` gate, `requestNow`. Registered in `WalletContext.tsx` beside `TaskCreditInbox` with its own `credit` closure — **not** folded into `TaskCreditInbox.runTask`, which calls exactly one injected callback (`TaskCreditInbox.ts:70-76, 95-114`) and whose result shape and `onAccepted` toast belong to the BSV inbox. |
| 13 | `W/core/pay/tokenSendErrors.ts` | `classifyTokenSendError(e, ctx) => { key: string; values: Record<string,string>; guarantee: 'nothing-sent' \| 'unknown'; action?: 'check-again' \| 'get-bsv' }` | Pure, unit-testable, on the `core/pay/creditErrors.ts` precedent. §4.5. |
| 14 | `W/core/mandala/journalStore.ts` | `makeMandalaJournalStore(storage: StorageLike) => { load(): Promise<Record<string, unknown>>; put(k, v): Promise<void>; remove(k): Promise<void>; hydrated: Promise<void> }` | **D3.** One JSON blob per journal under `mandala_tx_journal` / `mandala_notify_journal` / `mandala_blinding_journal`, over `StorageExpoSQLite.getKeyValue/setKeyValue` (`:215-227`), with the per-storage promise-chain mutex from `W/core/peerpay/outbox.ts:96-107`. **`reconcileWallet` must await `hydrated`** — otherwise `hasFreshIntent()` reads an empty map and the bulk sweep at `L/reconcile.ts:120-133` aborts a live transaction. |
| 15 | `W/core/mandala/config.ts` | `configureMandalaForChain(chain)`, `isMandalaAvailable(chain)` | Reads `ToolboxServiceConfig.mandala` and calls the lib's `configureMandala`. |
| 16 | `W/core/mandala/adminWallet.ts` | `withAdminOriginator(pm, ADMIN_ORIGINATOR): WalletInterface` | ~30 lines appending the originator to the 13 methods the lib calls. Removes the spending sheet per send (`WalletPermissionsManager.js:2878`), `guardVaultAccess`'s external path, the `limit ≤ 500` denial (`guard.ts:30,195`) and the per-mutation inventory scan. **A deliberate trust decision**, stated as one: the lib runs with the same authority the wallet's own rails already hold. |

### 3.3 CHANGED — precise edits

| # | File:line | Change |
|---|---|---|
| 1 | `W/ui/components/wallet/AmountInput.tsx:38-53` | Add `asset?: AmountAsset` and `maxValue?: string`. |
| 2 | `:79-81` | `const isFiat = asset == null && isFiatCurrency(currency)` — **one line**, and it makes every existing fiat branch (`:83-115` effect, `:117-122` handler, `:151-159` display/keyboard/unit/secondary) inert in asset mode with no other edit. This is the fix for the three-way-mode collision: without it the resync effect at `:89` would take base units, divide by `satoshisPerFiatUnit` and clobber the typed figure. |
| 3 | `:83, :84, :86-115` | Rename `fiatDisplayValue` → `displayText`, `lastEmittedSats` → `lastEmitted` (both modes now use them). The existing effect already returns early on `!isFiat`, so #2 makes it inert in asset mode; a **second** effect with the same self-resync guard (`if (value === lastEmitted.current) return`) syncs `displayText` from an externally-changed `value` using `formatAmountFixed(Number(value), asset.decimals)`. Two effects, mutually exclusive by mode, neither able to run in the other's mode. |
| 4 | `:81` | `const fractionDigits = asset ? asset.decimals : isFiat ? fiatFractionDigits(currency) : 0` |
| 5 | `:117-128` | `handleChangeText` asset branch: same mask `^\d*\.?\d{0,N}$`, emit `String(parseAmount(text, asset.decimals))`; `NaN` ⇒ emit `''` (the field never emits a non-integer). |
| 6 | `:130, :151-159` | `const isSendMax = asset == null && value === SEND_MAX_VALUE`; `unitLabel = asset ? asset.ticker : isFiat ? currency : 'satoshis'`; `secondaryText = asset ? null : …` — **the converted line is suppressed in asset mode**. |
| 7 | `:183` | Max: `onPress={() => onChangeText(asset ? (maxValue ?? '') : SEND_MAX_VALUE)}`. The `'2099999999999999'` sentinel is a satoshi-domain concept and never enters token code; in asset mode Max writes the real spendable figure, which is exact because token outputs are 1 satoshi and fees come from BSV. |
| 8 | `W/ui/components/pay/PayForm.tsx:58-75` | `PayAmountField` gains `asset?`, `maxValue?`, `availableText?`, `availableNote?` and passes them to `AmountInput` / `AvailableBalance`. |
| 9 | `PayForm.tsx:76-86` | `ConsequenceNote` gains `values?: Record<string, string \| number>` (so `t(textKey, values)` interpolates — today it calls `t(textKey)` with no options and every new note carries `{{ticker}}`/`{{issuer}}`) and `action?: { label: string; onPress: () => void }`, rendered as a trailing `PressableScale` text button with `hitSlop` to 44pt. This is what carries "Get BSV ›" and "Check again". |
| 10 | `PayForm.tsx:88-124` | `PayCta` gains `label?: string` (raw, pre-interpolated; wins over `labelKey`) — `t(labelKey)` takes no options, so "Send 25.00 USDX" cannot come from a key alone. |
| 11 | `W/ui/components/pay/AvailableBalance.tsx:29-32` | Gains `text?: string` and `note?: string`. When `text` is present it is rendered verbatim and `useSpendableBalance()` is not consulted — the component takes **no** balance prop today and sources its own BSV figure, so nothing else can produce a token figure. |
| 12 | `W/ui/components/pay/RecipientField.tsx` | Gains `assetTicker?: string`. When present and the classified input is `address` / `invalid_address`: status line becomes `alert-circle-outline` + `t('pay_asset_address_status', {ticker})`, border `colors.warning`. **Non-destructive** — the typed text stays; switch the picker back to BSV and it is valid again immediately. Also gains `statusOverride?: { icon, text, tone }` for the recipient-admission line (§4.3). |
| 13 | `W/ui/components/pay/UniversalSend.tsx:476-483, :354, :541, :572` | Mount `<AssetPicker>` in a `PayField labelKey="pay_asset_label"` above `RecipientField`; thread `asset` into `PayAmountField`; branch `handleSend` on `asset != null` → `sendTokenViaHandle`; extend `canSend`; new `ConsequenceNote` branches; `ResultBanner` fed by `classifyTokenSendError`; CTA `label`. |
| 14 | `W/ui/components/pay/RequestHub.tsx` | Gains `assets`, `selected`, `onSelect`, `asset`; mounts `AssetPicker` above `PayAmountField`; passes `asset` down; address row `disabled` with `t('pay_asset_address_status')`; remote-link subtitle → `t('pay_asset_link_no_amount')`. `requestSatsFrom` is **not** reused for a token amount (see #16). |
| 15 | `W/ui/screens/PayScreen.tsx:136-142, :385-411` | Accept an `asset` search param; hold `selectedAsset` state; thread into `UniversalSend` / `RequestHub` / `HandleReceive` / `NearbyFlow`. |
| 16 | `PayScreen.tsx:184, :386` | **Bug fix the winner shipped:** `const sats = requestSatsFrom(requestSats)` is passed to `HandleReceive initialSats` and `initialNearbyRequest`. When an asset is selected, `requestSats` is base units and would render as satoshis. Replace with a discriminated `request: { kind: 'bsv'; sats?: number } \| { kind: 'token'; baseUnits?: number; asset: TokenAsset }`. |
| 17 | `W/ui/components/pay/HandleReceive.tsx:442, :689-691, :154/:582` | `requestedAmountText?: string` replaces the `<AmountDisplay>{initialSats}</AmountDisplay>` render when present; `peerPayLinkFor` is called with `sats` omitted when an asset is selected (it already omits non-positive figures — zero code change); `AdmissionNotice` replaces the plate when not admitted; the existing 5s focused tick also calls `TaskCreditToken.requestNow()`. |
| 18 | `W/ui/screens/WalletHomeScreen.tsx:1183` | `t(assets.length > 0 ? 'wallet_balance_your_bsv' : 'wallet_balance_you_have')`. |
| 19 | `WalletHomeScreen.tsx:1244` | `listHeader` gains `<BalancesSection/>` as its first child, above the resend banner. `pinnedHeader`, `refreshBalance`, `fetchActions`, `loadMore` and the fixed-height footer are **untouched** — the three `loadMore` guards and the footer at `:721-750, :1432-1440` exist to break an `onEndReached` loop and nothing here goes near them. |
| 20 | `WalletHomeScreen.tsx:1100-1145` | The row renderer passes `token` to `ActivityRow` for any action whose `labels` include `'mandala'` (`includeLabels` is already `true` at `:633`). |
| 21 | `W/ui/components/wallet/ActivityRow.tsx:70-74, :147-159, :170-179, :270-293` | Add `token?: { title: string; amount?: { value: string; unit: string }; incoming: boolean; suppressFace: boolean }`. When present: description ← `token.title` (the lib writes `Receive 4000 of 615a06ab….0` at `L/receive.ts:143` and `ActivityRow` renders `action.description` verbatim at `:270-272`, so the title **must** be overridden); the amount column renders `token.amount` or `t('token_row_amount_pending')` in `textTertiary` and **never** `formatAmountParts(action.satoshis, …)`; the secondary denomination line is omitted; `suppressFace` skips the sigil. Absent `token` ⇒ byte-identical. Note the local `const face` at `:172` — the new prop is named `token.suppressFace`, not `face`. |
| 22 | `W/core/pay/counterparty.ts:71-85` | One branch **before** the txid fallback: `const PREFIXED = /^to-((?:02\|03)[0-9a-f]{64})$/`; a match returns `{ kind:'identityKey', value: m[1] }` — the **extracted capture**, not the whole label, so the same person's face matches on the BSV rail. Deliberately not `from-`, which under D2 is `A′`. |
| 23 | `W/ui/components/pay/PaymentSuccessOverlay.tsx:53-75, :197-198` | Add `amountText?: string` (rendered instead of `<AmountDisplay>{amount}</AmountDisplay>`), `notified?: boolean`, `firstHoldNote?: string`. The `!broadcast` line at `:197-198` renders `pay_received_not_broadcast` ("Received offline · not yet processed") **ungated by direction** — so a sent overlay gains its own key `pay_sent_not_broadcast`. |
| 24 | `W/ui/exportTransactions.ts:36-80` | Two columns, `assetId` and `assetAmount`, filled for `'mandala'`-labelled rows from one extra `listOutputs({basket:'mandala-tokens', includeCustomInstructions:true})` + `parseActionsToHistory` over the action set it already pages (`includeOutputs: true` is already set at `:49`). The `satoshis` column stays truthful: for a token row it is the BSV movement, i.e. the fee. |
| 25 | `W/core/pay/damagedInbox.ts:1-22` | `DamagedInboxReason` gains `'wrong_box'`; a body carrying both `assetId` and `protocolID` in `payment_inbox` reads as misrouted mail with a **discard**, not damaged money with a retry that can never succeed. Defensive only — Mandala delivers to `'mandala-payments'` (`L/constants.ts:11`) and `creditInbox.ts:85-89` lists only `payment_inbox`, so the two never meet by construction. |
| 26 | `W/core/context/WalletContext.tsx:1393-1439, :2259-2267, :2287` | Register `TaskCreditToken` beside `TaskCreditInbox` with its own closure; fan out on the same online/foreground signals; construct the Mandala `MessageBoxClient` once; `await journalStore.hydrated` before `reconcileWallet`. |
| 27 | `W/core/toolboxConfig.ts:10-14` | `ToolboxServiceConfig` gains `mandala?: { overlayUrl: string; overlayIdentityKey: string; messageBoxUrl: string }` per chain; the host populates it from `EXPO_PUBLIC_*` in `WR/app/_layout.tsx:56-84` (the package must not read `process.env`). |
| 28 | `W/core/localpay/codec.ts:14-21, :140-157, :176-195` | **D2.** For `kind:'token'`, `senderIdentityKey` carries the **blinded** `A′`; the docblock says so. `TokenPayment.recipientLinkage: Uint8Array` is renamed `admission: Uint8Array` — see §4.7 for why a payee-decryptable linkage is impossible under blinding and what replaces it. `__tests__/localpay/codec.test.ts:234` moves with it. |
| 29 | `W/core/localpay/verify.ts:106-133` | **D2, and it is one line.** `getPublicKey({ protocolID: FT_PROTOCOL_ID, keyID: \`${prefix} ${suffix}\`, counterparty: frame.senderIdentityKey, forSelf: true })` is **already correct** under blinding: `k = HMAC(S′, "2-mandala token-<keyID>")` with `S′ = ECDH(A′, B)` and the lock `hash160(B + kG)` is exactly the BRC-42 `forSelf:true` derivation with `counterparty = A′` (`L/blinding.ts:131-160`, `L/unlock.ts:60-64`). The only edit is the comment and the `assetId` check; the derivation stands. |
| 30 | `W/core/localpay/verify.ts:148-200` | `verifyRecipientLinkage` → `verifyAdmission(signature, txid, overlayIdentityKey)`. Zero production callers today, so the change is contained. |
| 31 | `W/core/localpay/build.ts:19-29, :96-207, :295-391` | The token build path (§4.7). `PayingWallet` gains `listOutputs`, `signAction` (present), `createSignature`, `revealSpecificKeyLinkage`, `encrypt`, `decrypt`, `revealCounterpartyKeyLinkage`. |
| 32 | `W/core/localpay/pending.ts:299-320` | `processPending` branches on `p.frame.kind`: token frames internalize with `protocol: 'basket insertion'` and the `insertionRemittance` of the committed spec §5. |
| 33 | `W/ui/components/pay/NearbyFlow.tsx:775-788, :1099, :1893` | Lift the `verified.kind !== 'bsv'` refusal to an asset-match against `session.asset.id`; `mintSession({ asset })`; base-unit amount binding (`isRequestableAmount` is already unit-agnostic, `session.ts:149-151`). |

### 3.4 Lib changes (this repo)

| # | File | Change |
|---|---|---|
| L1 | `L/constants.ts:16-17` | **D3.** Remove `import.meta` (`babel-preset-expo`'s `import-meta-transform-plugin.js:16-19` throws at transform time). Endpoints set only by `configureMandala`. |
| L2 | `L/package.json` | **D3.** Add a `"default"` export condition alongside `"import"`, so Jest (CJS) can resolve `@bsv/mandala`. `@bsv/*` move to `peerDependencies` so the wallet's patched `@bsv/sdk@2.4.1` is the only copy in the bundle. |
| L3 | `L/txJournal.ts`, `L/notifyJournal.ts`, `L/blindingJournal.ts` | **D3.** Injectable async store with a hydrate-once write-through memory cache, preserving today's synchronous read API (`journalList`, `hasFreshIntent`, …). |
| L4 | `L/amount.ts` | Add `formatAmountFixed(baseUnits, decimals)` — **does not trim trailing zeros**. `formatAmount(100, 2)` returns `'1'` today (`toParts` right-trims at `:11`), so every wireframe figure in every proposal — `1,240.00`, `Send 25.00 USDX` — is unreachable through the function they named. A fixed-decimal figure reads as money; a trimmed one reads as a quantity. The wallet uses `formatAmountFixed` everywhere and **never** `formatCurrency`/`currencySymbol`, which prefix `$` for a USD ticker and would put two different meanings of `$` on one screen beside the hero's `$9.33`. |
| L5 | `L/metadata.ts:6,44` | TTL on the negative cache (60s) so a transient outage does not make an asset unrecognisable for the process lifetime; injectable `ChainTracker` so the wallet's `OfflineFirstChaintracks` replaces the unkeyed `WhatsOnChain('main')`. |
| L6 | `L/receive.ts:121` | `const decimals = meta?.decimals` — drop `Number(…) \|\| 0`. `AssetMetadata.decimals?: number` is already optional in `@bsv/templates`; the defect is the consumer collapse, here and in the web app's `useHolderData.ts:76-81`. |
| L7 | `L/overlay.ts:39-43, :96-114` | `broadcastAcceptedTx` checks `sendWithResults[txid].status === 'failed'` and throws (matching `W/core/pay/rails/handle.ts:355-356` and `build.ts:253`); `submitAndBroadcast` gains `awaitBroadcast?: boolean` and returns `{ ...admitted, broadcast: 'ok' \| 'pending' }`. The detached `void broadcastAcceptedTx(...)` is cancelled by backgrounding on a phone — the mobile caller passes `awaitBroadcast: true`. |
| L8 | `L/transfer.ts:58-64` | `TransferResult` gains `broadcast: 'ok' \| 'pending'`. |
| L9 | `L/blinding.ts:131-175` | `prepareBlindedPayment` gains `extraVerifiers?: string[]` returning `extraLinkages: Record<string, SpecificLinkage>` — needed only if a payee-bound linkage is ever revived; see §4.7. |
| L10 | `L/reconcileBans.ts:24-45` | Decode each held output's locking script (`include: 'locking scripts'`) **before** relinquishing, and return `Array<{ outpoint, assetId, amount }>` instead of `string[]`, so eviction can be named with a figure. |
| L11 | `L/history.ts:246-256` | Parametrise the hard-coded `limit: 1000` on both calls. |

---

## 4. The send flow

Two rails (D4): **handle (MessageBox)** and **nearby**. No address rail.

### 4.1 Handle rail — the numbered sequence

**0. Idle.** Pay opens. `AssetPicker` shows BSV selected. If the wallet holds no token the picker does not exist and the screen is today's screen.

**1. Asset selected.** Tapping a token row: the amount field's unit becomes the ticker, `fractionDigits` becomes `asset.decimals`, the available line becomes the token's spendable figure, `RecipientField` gains `assetTicker`, and any already-typed address turns warning-toned (non-destructively). `resolveAssetState(assetId)` is fetched on selection.
 *State:* if `asset.decimals === undefined`, the row is `disabled` in the picker and cannot be selected; if selected before metadata failed, a `ConsequenceNote` reads `pay_asset_unidentified` and the CTA is disabled.

**2. Resolving recipient.** Unchanged: `useRecipientInput`'s 400ms-debounced `IdentityClient.resolveByAttributes`, pasted 66-hex key, QR scan. `classifyRecipientInput` is **not** touched — it stays pure (invariant 21).

**3. Recipient resolved — the pre-flight that does not exist today.** The moment a key resolves, three checks run against data already on the wire:
 - `resolveAssetState().blockedIdentities.includes(key)` → `RecipientField.statusOverride` = `pay_asset_recipient_blocked`, CTA disabled.
 - `accessMode === 'allowlist' && !allowedIdentities.includes(key)` → same treatment.
 - `useRegistryAdmission().check(key)` is `not-admitted`/`revoked` → `pay_asset_recipient_unregistered`, CTA disabled.

 This is the fix for the system's single invisible wall: the overlay screens the **recipient's** identity and refuses the **sender's** transaction two devices away (`overlay-go/internal/mandala/topic_manager.go:405-415, 455, 488-503`; `overlay/src/registry.ts:179-188`), and today neither party can diagnose it. Stated inline, before the amount question, at zero extra network cost — `resolveAssetState` already fetches `accessMode`/`allowedIdentities`/`blockedIdentities` (`L/adminState.ts:3-12`) and no holder component reads them.

**4. Amount.** Base units in, base units out (§3.3 #1–#7). Under the field: `availableText = formatAmountFixed(spendableBaseUnits, decimals)` + `t('available')`, and when `frozenBaseUnits > 0` a second line `pay_asset_frozen_note`. Frozen is **advisory** — it is already excluded from coin selection (`L/ftCandidates.ts:105-111`) — and only blocks when it makes the typed amount unreachable.

**5. Pre-flight notes above the CTA** (`ConsequenceNote`, the app's established "consequence before the button" slot, `PayForm.tsx:76-86`). At most one is shown, in this order:

| Condition | Source | Key | CTA |
|---|---|---|---|
| `decimals === undefined` | metadata | `pay_asset_unidentified` | disabled |
| `isPaused` | `resolveAssetState` | `pay_asset_paused` | disabled |
| self not registered | `useRegistryAdmission().selfStatus` | `pay_asset_self_unregistered` | disabled |
| recipient blocked / unallowed / unregistered | §4.3 | rendered on the field, not here | disabled |
| amount > spendable | local | `pay_asset_over_balance`, inline under the amount | disabled |
| `useSpendableBalance() === 0` | hook | `pay_asset_needs_bsv` + action `t('pay_asset_get_bsv')` → `/pay?direction=get` | **enabled** |
| `0 < balance < TOKEN_FEE_FLOOR_SATS` | hook | same note, no action | **enabled** |

**The BSV gate never disables the button and never reads `null` as zero.** `useSpendableBalance()` returns `number | null` and returns `null` on every cold open, whenever `balance.key !== cacheKey`, and for the whole window after a network switch (`W/ui/hooks/useSpendableBalance.ts:16-18, :84`). `null < 200` is `true` in JavaScript, so the naive gate tells a user with 50,000,000 satoshis that they need BSV. The rule is `balance !== null && balance < TOKEN_FEE_FLOOR_SATS` for the copy, and **the CTA is never disabled on it** — the authoritative failure is the toolbox's own funding throw, which `classifyTokenSendError` maps back to the same sentence. Blocking on an estimate is a lie in the other direction, and this is the same `null ≠ 0` invariant the design enforces for the token balance (invariant 8, `VaultScreen.tsx:858-866`).

**6. No review screen.** `PayCta` sends directly, as every handle send in this app does (`PayScreen.tsx:1-13`, "two screens, no chooser"). The confirmation is the button: `label = t('pay_asset_cta', { amount: '25.00', ticker: 'USDX' })` → **"Send 25.00 USDX"**. A verb plus its exact object under the user's finger beats a screen repeating what is already on screen. `NearbyFlow`'s `send_confirm` phase remains the additive lever if testing demands one.

**7. Handing over — no pre-submit.** Per the 2026-09-15 maintainer decision (offline-settlement spec §12.9), the handle rail is hand-over-first, identical in structure to the nearby rail (§4.3): the payer never checks anything with the issuer at send time. `PayCta busy`. Under it: `sendStartedRef` → `sendFlight.tryAcquire()` (synchronous, before any await) → `guardSendSubmit` → `sendTokenViaHandle` → `transferTokens` → `loadFtCandidates` → `selectFtInputs` → `generateFtChange` → `prepareBlindedPayment` → `createAction` → `matchOutputIndices` → `walletMandalaUnlock` → `signAction({noSend:true})` → assemble the AdmissionBundle from local evidence → `journalPut('handed_over')` → `sendMessage` posts the v2 body (§9.13 of the wire contract) to `'mandala-payments'`. No `/submit`, no broadcast, and no σ_I for the tip happen here — the recipient's own drain runs `COVER`, credits the payment, and submits (ancestors first, tip last). **Hand-over accepted** (that post acknowledged) → **if online, the payer submits the same bytes immediately** (idempotent; the overlay broadcasts on admission), instead of waiting for the drain's next tick; **if offline, the drain submits on reconnect**, exactly as before. The recipient's own submit stays valid either way — order between the three submitters is never load-bearing (offline-settlement spec §0.1 rule 3/6, maintainer decision §12.10; wire contract §9.13). Order between hand-over and this submit IS load-bearing, and inviolable: the submit never runs before, or instead of, the acknowledged hand-over.

**8. Success.**

```
              ┌─────────────────────────────┐
              │             ✓               │  Celebration, haptics.success
              │        25.00 USDX           │  amountText
              │         to Alice            │
              │                             │
              │   Sent · settling with      │  default, until an admission
              │   {{issuer}}                │  for the tip lands (§4.3)
              │                             │
              │   Sent · settled with       │  once the payer's own immediate
              │   {{issuer}}                │  submit (or the drain's) already
              │                             │  returned σ_I before the screen
              │                             │  dismisses
              │        [   Done   ]         │  appears after ~700 ms
              └─────────────────────────────┘
```

Settlement is never claimed at hand-over — it is an activity/settlement state (§5, and offline-settlement spec §5), not a send-time fact. The success screen defaults to **"Sent · settling with {{issuer}}"** and only shows **"Sent · settled with {{issuer}}"** when the immediate submit (§4.1 step 7, or the drain's) already returned σ_I(tip) before the screen dismisses, matching the nearby rail's copy (§4.3). This replaces the former broadcast-pending / not-notified qualifier lines, which described a claim about network delivery this rail no longer makes at send time.

### 4.2 Every failure, with its exact copy

Pre-flight (nothing has happened; CTA disabled unless noted):

| Condition | Copy |
|---|---|
| amount > spendable | **More than your USDX balance.** |
| asset paused | **Acme Bank has paused USDX transfers, so this can't be sent right now.** |
| you not registered | **Acme Bank hasn't registered you to send USDX. You can still be paid in it.** |
| recipient not registered | **Acme Bank hasn't registered this person for USDX yet, so they can't be paid in it.** |
| recipient blocked / not allowlisted | **Acme Bank does not allow payments to this person.** |
| address typed | **USDX can only be sent to a person or a nearby device — not to a Bitcoin address.** (field: *Not available for USDX*) |
| metadata unresolved | **This wallet couldn't identify this token, so it can't send it yet.** |
| no BSV (CTA stays enabled) | **Sending USDX needs a little BSV for the network fee. Receiving doesn't.** [ Get BSV › ] |
| part frozen (advisory) | **120.00 USDX of your balance is frozen and can't be sent.** |

Post-submit — local, before hand-over (`ResultBanner`, tone `error`), driven by `classifyTokenSendError`. Since the handle rail no longer contacts the overlay at send time (§4.1 step 7), every row here is a **local** failure — nothing that requires an overlay round-trip appears in this table any more:

| Thrown | Narrowing | Copy |
|---|---|---|
| `'insufficient token balance'` | `selectFtInputs` | **Your USDX balance changed while this was being prepared. Check the amount and try again.** |
| toolbox funding throw at `createAction` | — | the same **needs-BSV** sentence, with [ Get BSV › ] |
| `BusyError` | `sendFlight` / web lock | **A USDX payment is already going out.** |

**Overlay outcomes are not send-time failures on any rail.** Paused-asset, blocked/unallowed/unregistered-recipient, frozen/evicted-outpoint, and outright refusal are all outcomes the overlay can only render *after* hand-over, once the recipient's (or the payer's own) drain submits — so they no longer have a row in this table. They surface as activity/settlement states instead (§5; and offline-settlement spec §5's `settling` / `settled` / `refused` / `reversed` / `stuck` states), on the same activity entry the success screen (§4.1 step 8) already points at. The copy that used to read "We couldn't reach Acme Bank to confirm this transfer" is retired outright — there is no send-time issuer check left to fail.

Two rules make this copy safe:

1. **Pre-flight is advisory and may only ever say "no".** `resolveAssetState` has a 10s TTL and fails open on `null` (`L/adminState.ts:15-27`), and `useRegistryAdmission` fails open on any ambiguity. No pre-flight string ever says "this will work" — a clean pre-flight is not a settlement guarantee, only the activity/settlement state is.
2. **A local throw at hand-over never implies overlay contact.** Every row above fires before the AdmissionBundle is even assembled or the MessageBox body is posted, so "nothing was sent" is always true for them without narrowing against overlay state.

The `issuer` in this copy is `resolveAssetState().issuerIdentityKey` resolved through `resolveIdentity`, falling back to `abbreviateKey`. When the issuer cannot be named, every `{{issuer}}` string, including the settling/settled activity states (§5), has a sibling that says "the issuer" — an activity state in particular must not attribute a refusal or a stuck settlement to a party that may not be the one responsible (the two coincide only in the demo, where `isIssuer = identityKey === OVERLAY_IDENTITY_KEY`).

**No dev-mode pause bypass.** The web app ships `?dev=1` persisted to `localStorage` that deliberately bypasses the client pause guard. That is a production escape hatch around a compliance control and it does not ship on a phone.

### 4.3 Nearby rail — the numbered sequence

**v1 supports fully offline nearby token payments, per the maintainer's
settlement model (§0.1 of the offline-settlement-final spec).** The payer
builds and hands over the frame **without** submitting first — submission
is the recipient's job (rule 3), with the payer's own drain submitting
too, optionally, whenever it next comes online (rule 6). Steps:

**Payee:** unchanged from the existing draft — selects the asset, types
base units, picks "Someone nearby", `mintSession({asset})`.

**Payer:**
1. Scan → `classifyScan` (unchanged).
2. Overlay-mismatch refusal (unchanged — v1 is single-overlay).
3. `send_confirm` shows "Pay 25.00 USDX to ◈alice" (unchanged).
4. `buildPaymentFrame` token path: select from `mandala-tokens`
   [renamed `p mandala`, §8] with `include:'entire transactions'`; lock via
   `prepareBlindedPayment`; two-step `createAction`/`signAction({noSend:
   true})`; **assemble the AdmissionBundle** (§1.1 of the offline-settlement-
   final spec) from the wallet's own `token_admissions`/`token_admission_edges`/
   `token_linkage_payloads` tables for every ancestor in the transfer's own
   BEEF.
5. **Hand over the frame immediately — no pre-submit.** This restores the
   committed spec's original §4 step 6 (submit after the positive ack, on
   the DRAIN, not before hand-over) and is the point of this revision: the
   payer never blocks a face-to-face payment on connectivity.
6. **Hand-over accepted** (nearby positive ack) → `holdSentPaymentOffline`
   (§4.4's advancing-UPDATE fix, if the row is `parked`).
7. **If online, the payer submits the same bytes immediately** (idempotent;
   the overlay broadcasts on admission), instead of waiting for the
   drain's next tick; **if offline, the drain submits on reconnect** — the
   drain owns everything from here (§4.3 of the offline-settlement-final
   spec) exactly as before. The recipient's own submit stays valid either
   way (§0.1 rule 3/6; wire contract §9.13; maintainer decision §12.10).
   Order between hand-over (step 6) and this submit is inviolable: the
   submit never runs before, or instead of, the acknowledged hand-over.
8. Success screen: **"Sent · settling with {{issuer}}"** by default — **"you'll
   see it confirm once you or Alice reconnect"** while offline — and only
   **"Sent · settled with {{issuer}}"** when step 7's immediate submit (or
   the drain's) already returned σ_I before the screen dismisses.

**Payee settle:** `verifyFramePayment`'s token branch runs unchanged
(already correct under D2, per ux #29). The frame is credited — spendable
immediately — the moment `COVER` (§1.2 of the offline-settlement-final
spec) returns `ok:true`; a frame that fails `COVER` is refused at hand-over
exactly like a `not_mine`/`unparseable` decode failure today, with copy
**"This payment doesn't check out with Acme Bank's records and was not
accepted."** The three-tone receipt doctrine applies: **"Received offline ·
not yet confirmed by Acme Bank"** until the drain's own `postTokenStep`
returns `broadcast`.

**Credit:** unchanged — `processPending` branches on `frame.kind`,
`internalizeAction` with `protocol:'basket insertion'` into `'p mandala'`.

---

## 5. The receive flow

### 5.1 Noticing — a sibling drain, never a widened one

Mandala uses `'mandala-payments'` (`L/constants.ts:11`); `creditInboxOnce` lists only `'payment_inbox'` (`W/core/pay/creditInbox.ts:85-89`). The two never meet, so `isPaymentTokenShape`, `DAMAGED_TOKEN_PLACEHOLDER`, `autoAcceptInbox` and `MAX_AUTO_ATTEMPTS` are provably untouched. The `'wrong_box'` reason (#25) is defensive only, for a misconfigured sender.

`creditTokenInboxOnce` wraps `receiveTokens`, which already carries every invariant this wallet demands: `verifyIncoming` re-derives asset and amount from the actual output before any wallet write (`L/receive.ts:32-59`); acknowledge only after a successful internalize (`:124-152`); `isAlreadyInternalized` treated as success so the ack can complete; a poisoned body acked and dropped exactly once; a transient failure left un-acked with its id removed from `processed`. The `processed` set is persisted through the D3 store.

Three drivers, all existing:
1. **`TaskCreditToken`** — a sibling task registered beside `TaskCreditInbox` in `WalletContext.tsx:1393-1439`, inheriting the `onlineNow` gate and the 10s→5min backoff. Not a second step inside `TaskCreditInbox.runTask`: that task calls one injected callback and owns the BSV inbox's pending/backoff and its `onAccepted` toast.
2. **`HandleReceive`'s focused 5s tick** (`:154, :582`) also calls `TaskCreditToken.requestNow()`.
3. **`WalletContext`'s foreground/online fan-out** (`:2259-2267, :2287`).

**Receive-side failures surface.** `creditTokenInboxOnce` returns `{ accepted, failed }`; `failed.length` feeds the existing `homeBadges` machinery via a new kind `'token_attention'`, rendered as one `ListRow` in the slot the stuck-work badges already occupy. "They said they sent it and it never arrived" must have a surface. A `held` row that has passed `COVER` and been credited but has not yet reached `broadcast` after 3 days surfaces via the same `'token_attention'` `homeBadges` kind already specified, with copy **"Waiting on Acme Bank to confirm — tap for details"** (FIX M).

### 5.2 Showing it

| Where the user is | What happens |
|---|---|
| On a receive surface, foreground | full-screen `PaymentSuccessOverlay direction="received"` with `amountText` — money arriving gets a screen, never a toast (invariant 13) |
| Anywhere else, app open | `sounds.paymentReceive()` + `onToast(t('payment_arrived'), {type:'success'})` — **the existing BSV precedent** at `WalletContext.tsx:1435-1439`, gated on `isReceiveInboxFocused()` exactly as BSV is. A monitor task has no screen to raise an overlay from, and inventing one would be a different arrival model for tokens. |
| App closed | nothing (no push channel exists). The Balances row and Activity update on the next `txStatusVersion` bump — the same contract BSV has. |

**First time this wallet has ever held this asset**, the overlay gains one line:

```
              │       +40.00 USDX           │
              │                             │
              │  USDX is issued by Acme     │  firstHoldNote, first hold only
              │  Bank, who can pause        │
              │  transfers and freeze coins.│
```

Disclosure at the one moment the user is definitely looking, using a slot the overlay already lays out. Thereafter it is silent and lives in the sheet, discoverable from the row's "New — tap to see who issues it" subtitle.

**Not-yet-confirmed qualifier.** The arrival overlay (`PaymentSuccessOverlay direction="received"`) gains a `not yet confirmed by {{issuer}}` qualifier line, sourced from `token_settlements.state !== 'broadcast'`, using the existing `firstHoldNote`/`amountText` slots — no new component.

### 5.3 There is no claim step

Incoming transfers are auto-credited. That is this wallet's doctrine (`creditInboxOnce` → `internalizeIncoming`, ack after credit, `HandleReceive.tsx:9-14`: *"accepting was never a decision anyone could act on, since the money is already theirs and refusing only leaves it in the box"*) and the lib's. A Reject button would be a lie: declining does not return the money, it leaves an un-acked message in a box.

### 5.4 "You can't be paid in this yet"

When an asset is selected on Get paid and `useRegistryAdmission().selfStatus` is `not-admitted` or `revoked`, `AdmissionNotice` replaces `HandleReceive`'s QR plate entirely:

```
┌──────────────────────────────────────────────┐
│  ‹              Get paid · USDX               │
├──────────────────────────────────────────────┤
│                    (◇)                       │  48pt outline, textTertiary
│                                              │
│      You can't be paid in USDX yet           │  title3 20/600
│                                              │
│   Acme Bank only sends USDX to people it     │  subhead, textSecondary,
│   has registered. Until then, payments to    │  centred, ~34ch
│   you are refused before they leave the      │
│   sender's wallet.                           │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ (↙) Get paid in BSV instead          › │  │  → sets the picker to BSV
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

Showing a code that manufactures a failure in someone else's app, attributed to nothing, is the error-prevention violation. Withholding it and naming the party who decides is the principle in one screen.

**On reachability, honestly:** because the picker only offers assets you hold, this screen can only be reached by a holder who was *revoked*. That is a real state and it deserves a real answer. The **first-time, never-admitted** user — the adoption wall — is served on the other side of the payment, at §4.1 step 3, where the sender is told "Acme Bank hasn't registered this person for USDX yet" and can act on it. There is no route inside the wallet to *become* registered (registration is the issuer's chain, gated by whatever the issuer requires), so the notice offers no "How to get registered" affordance that would dead-end; it names the party and offers the rail that works.

### 5.5 The QR and the handle

Unchanged. `HandleReceive` keeps the `peerpay:` link at 240pt with the bare identity key beneath and Copy / Share. **No `?asset=` is added to the BRC-125 grammar**, and the QR is **not** switched to a bare key — the link carries `?sats=` and `&url=` (the payee's message-box host, `handle.ts:76-84`), and dropping it would regress shipped BSV plumbing for token interop.

A `sats=` figure emitted while the payee was thinking in USDX would be read by the payer as satoshis — a unit-confusion money lie. So with a token selected the link simply carries no figure, which the existing grammar already means, and the method row says so before the tap: *"Share your handle — they choose the amount."* The exact token request already exists and is free: the nearby session's `t` block, where `amount` is binding base units.

**Message-box host.** Delivery requires sender and payee to share a host, or the sender to use the payee's `url` extension. The wallet's host is user-configurable (`message_box_url`, `NO_MESSAGE_BOX` sentinel) while `configureMandalaForChain` sets one global host. v1 resolution: `sendTokenViaHandle` passes the recipient's `messageBoxUrl` from the resolved target when the payer arrived via a `peerpay:` link, and otherwise uses the configured host; when the wallet's own host has been changed away from the configured Mandala host, the Get-paid picker shows a `ConsequenceNote` — **"Your wallet is set to a different message box, so token payments may not reach you."** A transfer admitted on chain that the payee never sees is a severe, unrecoverable state (the overlay exposes no identity-balance query), and it must not be silent.

---

## 6. Balance and activity surfaces, with their exact queries

### 6.1 Balances

```
useTokenAssets()                                   // gated on isMandalaAvailable + storageMatchesNetwork
  listOutputs({ basket: 'p mandala',               // W/core/storage/methods/listOutputsSql.ts
                include: 'locking scripts',
                includeCustomInstructions: true,
                limit: 1000 }, ADMIN_ORIGINATOR)
    → decodeBalances(outputs)                      // L/tokens.ts:10  → TokenBalance[]
  resolveAssetMetadata(assetId)                    // L/metadata.ts:25, memoised, 60s negative TTL
  resolveAssetState(assetId)                       // L/adminState.ts:17, once per foreground
    → frozenOutpoints.filter(f => f.owner === identityKey) ∩ own outputs → frozenBaseUnits
```

Invalidated on mount, `txStatusVersion` and `refresh()`. `txStatusVersion` bumps on every `createAction/signAction/internalizeAction/abortAction/relinquishOutput` (`WalletContext.tsx:1109-1124`, debounced 120ms), so a credit or a send repaints the rows for free. **This runs only for wallets on mainnet with Mandala configured** — the decode-every-locking-script pass does not land on a BSV-only user's home screen.

Three figures, never conflated: **total** on the row and in the sheet; **frozen** as a footnote naming the issuer as the actor; **spendable** on the send screen's available line. Frozen is *computed* (intersect `frozenOutpoints` with the holder's own basket outputs), not claimed. Frozen stays **inside** the row's total — those coins are still yours; subtracting them from the headline would be a different lie.

**No total, anywhere. No fiat, anywhere.** `ExchangeRateContext` is a BSV↔USD↔fiat chain fetched once on mount with a `HARDCODED_USD_PER_BSV = 16` fallback explicitly marked "Not for trading". It has no price for a token. Rendering `≈ $1,240.00` beside a USD-tickered stablecoin would be the wallet vouching for the issuer's peg using a number it invented from a ticker string.

### 6.2 Activity

One `FlatList`, one row component, one extra scoped query for token-holding wallets only.

```
useTokenActivity(mandalaTxidsOnScreen)
  listActions({ labels: ['mandala'], includeLabels: true, includeOutputs: true,
                includeOutputLockingScripts: true, limit: window })   // window 100 → 1000
  listOutputs({ basket: 'mandala-tokens', includeCustomInstructions: true, limit: 1000 })
  → join by outpoint → parseActionsToHistory(actions, ciByOutpoint)   // L/history.ts
  → Map<txid, { direction, assetId, baseUnits }>
```

Reusing `parseActionsToHistory` is the whole point: it already handles sent/received/issued/redeemed, multi-output change, recipient-output dropout falling back to the change CI's `sentAmount`, and never mistaking spent change for the recipient — 19 tested cases the wallet would otherwise reimplement. It reads from `listActions`' own outputs, so unlike a join against a live basket query it does **not** decay when a coin is later spent.

**Row identification is by label, not by holdings.** `action.labels.includes('mandala')` — the lib writes `['mandala','transfer','to-<key>']` and `['mandala','receive','from-<A′>']` — so a user who sends their last token keeps denomination across their whole history.

**The miss is defined.** A `'mandala'`-labelled action with no entry in the map renders as a token movement with the direction, the title, and **no figure** — `t('token_row_amount_pending')` in `textTertiary`. It never falls through to `formatAmountParts(action.satoshis, …)`, which for a token send is the net BSV spent and would print `−64 sats` for a payment of 25.00 USDX. A plausible wrong number is worse than a blank.

**Rows:**
1. Title `t('token_row_sent'|'token_row_received', {ticker})` — the lib's `description` is a developer string containing a raw 36-byte token id and `ActivityRow` renders it verbatim (`:270-272`).
2. Amount: `formatAmountFixed` + ticker, `colors.successAmount` for incoming (green means confirmed money and nothing else). Secondary denomination line **omitted**, not blanked.
3. Face: a **sent** row gets a real sigil, because the recipient is not blinded and `counterpartyOf` now extracts the key from the `to-<key>` label (#22). A **received** row gets `suppressFace` and the plain direction-arrow tile: under D2 the sender is `A′ = A + rG`, fresh per payment, and — this is the part that makes it a bug rather than a nicety — `counterpartyOf` does **not** return `null` for a mandala label; it falls through to `{kind:'txid'}` (`counterparty.ts:81-82`) "so that every action still gets a stable, if anonymous, face". Without suppression the wallet would draw a different plausible face for every payment from the same person. We never draw a face for a party we cannot name.
4. Day grouping, status dots, chip tray, expansion: unchanged. `withDayHeaders` keys on `created_at`, which the wallet's rows carry even though `HistoryRow.when` is always `0`.
5. Resend / Send-again chips stay absent: `resendableOutbound` requires a `peerpay`/`localpay` label (`:195-198`), and `rebuildPeerPayToken` picks the non-basketed output and reads `out.satoshis` — both invert for a token. No chip pretends a path exists.

### 6.3 Eviction — the one modal this design spends

`reconcileBans` relinquishes evicted outputs today with no UI at all: the balance just drops. On a phone, money disappearing without a sentence is the worst failure in the system.

With L10 returning `{outpoint, assetId, amount}`, the next foreground raises exactly one `showAlert` (the decisions channel; `Toast` is FYI only):

> **Some USDX was withdrawn**
> Acme Bank withdrew 40.00 USDX from your wallet.
> [ OK ]

No Activity row is fabricated — there is no transaction of the user's to show.

---

## 7. Asset trust and disclosure

**Where.** Three places, each the moment the fact becomes actionable: the arrival overlay (first hold only), the Asset sheet (permanent, on demand), and the pre-flight notes inside Pay.

**What "regulated" means, stated as capability.** Four powers, each a real gate in `topic_manager.go`, plus the limit. No badge, no shield, no trust score, no colour: chroma in this app is reserved for transaction status, never decoration.

**Issuer identity.** `resolveAssetState().issuerIdentityKey` (echoed from `MandalaAdmin.publicData.issuer`) through the existing `W/ui/resolveIdentity.ts:71-81` — best-effort, never rejecting, and never gating a money decision, per its own contract. Resolved → a name and avatar. Unresolved → `abbreviateKey` in monospace, which is honest.

**Paused** — issuer-wide, temporary: row subtitle in warning **text** (no filled pill; a filled chip here would out-shout the Pay button), sheet status row, Pay `ConsequenceNote` + disabled CTA. **Get paid stays enabled** — refusing to receive would be the wallet deciding on the issuer's behalf, and the payer's own app also sees the pause. One line on the Get-paid screen says so: *"Acme Bank has paused USDX, so a payment may not arrive yet."*

**Frozen** — your coins, indefinite: already excluded from selection; the total stays whole and a footnote names the subtotal and the actor. Where `resolveAssetState` gives exactly one `reason`, it is quoted verbatim as the sheet row's subtitle — it is the issuer's words to this user about this coin.

**Not registered** — you, blocking, requires action outside the wallet: §4.1 step 3 (as a sender) and §5.4 (as a payee).

**Asset-state freshness.** `resolveAssetState` has a 10s memo, caches `null`, and fails open. Home fetches it **once per app foreground**, debounced, held assets only — never per render. Pay fetches on asset selection and again, cache-bypassed, at failure time. Home shows nothing rather than a stale warning.

---

## 8. i18n keys to add

Every key is 12 locale entries with a real translation (`W/__tests__/i18n/translationParity.test.ts` rejects key-set gaps, placeholder mismatches, and any value byte-identical to English outside `allowedUntranslated`). **59 new keys = 708 entries.** The count is stated exactly because it is the single largest per-string cost in the design and the main reason the surface is this small; the per-block totals below sum to 59 (8 + 10 + 13 + 2 + 8 + 4 + 5 + 6 + 3).

Reused, not re-coined: `available`, `amount`, `recipient`, `pay`, `done`, `copied`, `send_max`, `no_transactions`, `payment_arrived`, `offline_copy_details`, `wallet_balance_you_have`.

**Balances / home (8)**
```
token_balances_header      Balances
wallet_balance_your_bsv    Your BSV
token_fee_footer           Sending needs a little BSV for the network fee. Receiving doesn't.
token_new_tap              New — tap to see who issues it
token_unresolved           Unrecognised token
token_unresolved_sub       This wallet couldn't look up who issues it. Try again when you're online.
token_paused_short         Transfers paused
token_frozen_short         {{amount}} frozen
```

**Asset sheet (10)**
```
token_sheet_issuer         Issued by
token_sheet_issuer_unknown Not identified
token_sheet_asset_id       Token ID
token_sheet_powers_header  What {{issuer}} can do
token_power_pause          Pause all transfers of {{ticker}}
token_power_freeze         Freeze specific coins, including yours
token_power_admit          Decide who may hold {{ticker}}
token_power_replace        Replace a frozen coin with a new one
token_powers_limit         They can't move {{ticker}} out of your wallet without you, and a frozen coin simply can't be spent.
token_frozen_sub           {{issuer}} has frozen {{amount}} {{ticker}} of your balance. Contact them to dispute.
```

**Pay — pre-flight (13)**
```
pay_asset_label            Paying with
pay_asset_label_get        Getting paid in
pay_asset_cta              Send {{amount}} {{ticker}}
pay_asset_over_balance     More than your {{ticker}} balance.
pay_asset_needs_bsv        Sending {{ticker}} needs a little BSV for the network fee. Receiving doesn't.
pay_asset_get_bsv          Get BSV
pay_asset_needs_bsv_short  Needs BSV for the fee
pay_asset_frozen_note      {{amount}} {{ticker}} of your balance is frozen and can't be sent.
pay_asset_paused           {{issuer}} has paused {{ticker}} transfers, so this can't be sent right now.
pay_asset_no_address       {{ticker}} can only be sent to a person or a nearby device — not to a Bitcoin address.
pay_asset_address_status   Not available for {{ticker}}
pay_asset_self_unregistered      {{issuer}} hasn't registered you to send {{ticker}}. You can still be paid in it.
pay_asset_unidentified     This wallet couldn't identify this token, so it can't send it yet.
```

**Pay — recipient (2)**
```
pay_asset_recipient_unregistered  {{issuer}} hasn't registered this person for {{ticker}} yet, so they can't be paid in it.
pay_asset_recipient_blocked       {{issuer}} does not allow payments to this person.
```

**Send failures (8)**
```
token_err_refused          {{issuer}} refused this transfer. Nothing was sent and your {{ticker}} is unchanged.
token_err_refused_paused   {{issuer}} has paused {{ticker}}. Nothing was sent and your balance is unchanged.
token_err_refused_recipient {{issuer}} does not allow payments to this person. Nothing was sent and your balance is unchanged.
token_err_refused_frozen   Some of the {{ticker}} you were sending has just been frozen. Nothing was sent; your balance has been updated.
token_err_unreachable      We couldn't reach {{issuer}} to confirm this transfer. Check your {{ticker}} balance before trying again.
token_err_check_again      Check again
token_err_balance_changed  Your {{ticker}} balance changed while this was being prepared. Check the amount and try again.
token_err_busy             A {{ticker}} payment is already going out.
```

**Success / arrival (4)**
```
pay_sent_not_broadcast     Sent. It hasn't reached the network yet — we'll keep trying.
pay_sent_not_notified      Sent. We couldn't tell them yet — they'll see it when their wallet next checks.
pay_sent_handed_to_wallet  Sent. They didn't take it in person, so we've sent it to their wallet instead.
token_first_hold           {{ticker}} is issued by {{issuer}}, who can pause transfers and freeze coins.
```

**Get paid (5)**
```
pay_asset_link_no_amount   Share your handle — they choose the amount
pay_asset_request_paused   {{issuer}} has paused {{ticker}}, so a payment may not arrive yet.
token_admit_title          You can't be paid in {{ticker}} yet
token_admit_body           {{issuer}} only sends {{ticker}} to people it has registered. Until then, payments to you are refused before they leave the sender's wallet.
token_admit_bsv_instead    Get paid in BSV instead
```

**Activity / receive / nearby (6)**
```
token_row_sent             Sent {{ticker}}
token_row_received         Received {{ticker}}
token_row_amount_pending   Amount unavailable
token_evicted_title        Some {{ticker}} was withdrawn
token_evicted_body         {{issuer}} withdrew {{amount}} {{ticker}} from your wallet.
local_pay_token_not_cleared  Received offline · not yet cleared by {{issuer}}
```

**Nearby / config (3)**
```
pay_asset_nearby_needs_network  Paying in {{ticker}} in person needs a connection. You can pay in BSV without one.
pay_asset_nearby_wrong_overlay  This request is for a token this wallet isn't set up for.
token_messagebox_mismatch       Your wallet is set to a different message box, so token payments may not reach you.
```

**Not a key:** the BSV row label in `AssetPicker` renders the literal string `'BSV'`, like `mainnet`/`testnet`/`teratest` in the existing `allowedUntranslated` list — a `pay_asset_bsv` key would be identical in all 12 locales and fail parity.

---

## 9. Accessibility and HIG checklist

**Hit targets (44pt, `hitTargets.minimum`).**
- `AssetRow`, the picker's collapsed trigger and every picker option are `ListRow`s (`minHeight: 44`).
- The Asset sheet's Pay / Get paid buttons and `AdmissionNotice`'s route row clear 44 by padding.
- **The two inline affordances are the risk:** "Get BSV ›" and "Check again" live inside `ConsequenceNote`, whose text is `typography.footnote`. They are `PressableScale` with an explicit `hitSlop` bringing the target to 44×44, and they are the note's trailing element so they never overlap the icon.
- No nested pressables are introduced. The Balances block sits in `listHeader`, outside the hero's whole-block `TouchableOpacity` (`WalletHomeScreen.tsx:1176-1196`), so no row is a target inside another target.

**Dynamic type.**
- `AssetAmount` renders `numberOfLines={1}` with `adjustsFontSizeToFit` and `maxFontSizeMultiplier={1.3}`, matching `PaymentSuccessOverlay.tsx`'s figure. The label column wraps; the figure does not reflow.
- `AmountInput`'s field stays `typography.largeTitle` (34/700) in asset mode; the ticker suffix is `typography.title3` as the satoshi suffix is today.
- Every `ConsequenceNote` string is written to fit two lines at default size and is allowed to wrap; none is truncated.
- The Asset sheet is `fitContent`, so a large type setting grows it rather than clipping the powers list.

**Colour.**
- A healthy token row carries **no chroma at all** — a neutral `surfaceSunken` icon well, `textPrimary` figure. This preserves the stated invariant that chroma is reserved for transaction status (`WalletHomeScreen.tsx:11-14`).
- Paused and frozen use `colors.warning` as **text and icon tint**, never a filled pill.
- Green is `colors.successAmount` on incoming amounts and the celebration mark only.
- Exactly one accent-filled control per view: Pay on Home, `PayCta` in the form, Pay in the sheet, "Add"/route rows nowhere.
- No state is communicated by colour alone: paused carries a `pause-circle-outline` glyph and a word; frozen carries `snow-outline` and a figure; the refused address carries an `alert-circle-outline` and a sentence.

**Reduced motion.**
- The picker expander is the `WalletConfigScreen` inline pattern — layout, no animation.
- `AmountInput`'s unit-label swap already uses `FadeInUp`/`FadeOutDown` gated on `useReducedMotion()` (`:161-162`); asset mode reuses it unchanged.
- `PressableScale` suppresses its scale under Reduce Motion while still firing haptics and `onPress`.
- No new animation is added anywhere; nothing exceeds `durations.moderate` (350ms) because nothing new animates.

**VoiceOver, money figures specifically.**
- `AssetAmount` sets one composed `accessibilityLabel` (`"1,240.00 USDX"`) with `accessibilityRole="text"` on the container and `importantForAccessibility="no-hide-descendants"` on the two child `<Text>`s, so the figure and its unit are never read as two fragments.
- `AssetRow` announces `"Acme Dollar, 1,240.00 USDX"` plus the subtitle when present, as one label, with `accessibilityRole="button"` and `accessibilityHint` naming what the tap opens.
- The hero announces `t('wallet_balance_your_bsv')` + the figure; its `accessibilityLabel` remains `wallet_balance_refresh` on the pressable, unchanged.
- The picker's collapsed row announces the selected asset and its balance, `accessibilityState={{ expanded }}`; each option carries `accessibilityState={{ selected }}` so the checkmark is not the only signal.
- `PayCta` announces its full raw label — "Send 25.00 USDX" — rather than the key.
- A row with no recoverable figure announces `"Sent USDX, amount unavailable"`, never silence.
- `AdmissionNotice` is a single `accessibilityRole="summary"` region so the title and the reason are read together before the route row.
- The eviction `showAlert` inherits `AlertCard`'s existing modal announcement and its `haptics.warning()`.

**Other HIG points.** Grouped inset lists with uppercase tracked headers and hairline separators, reused verbatim. Sheets for focused tasks, dismissible with a drag handle, matching `PermissionSheet`/`VaultCeremonySheet`. The `expo-router` stack stays one level — no tab bar, no second home, no new route. `router.dismissTo` (POP_TO) preserved everywhere. Progressive disclosure: zero pixels until an asset is held, then one row, then one sheet on demand, then one picker inside the flow that already exists.

---

## 9.5 Tradeoffs accepted

| Tradeoff | Why it is the right side of the trade |
|---|---|
| A new field row lands on the wallet's most-used flow (Pay) | Gated on `assets.length > 0`, so it is zero change for the wallets that will never hold a token — which is almost all of them |
| No review screen: a mistyped amount sends immediately | The CTA names the exact figure and asset; this is the same exposure every BSV handle send already carries; `NearbyFlow`'s `send_confirm` is the additive lever if testing demands one |
| The BSV hero keeps the one display-size figure while a token balance sits in a row | The hero *is* the fee balance, and the label swap ("Your BSV") removes the only way that layout could be misread. The alternative — two focal figures — means no focal point |
| Nearby token payments require the payer to be online in v1 | It removes the entire "credited then un-credited" failure class and the `offline_linkage` store from v1. The BSV nearby rail still works offline, and the refusal says so in one sentence |
| One overlay per chain; a session naming another is refused | The honest v1 answer to multi-issuer. The frame already carries per-asset endpoints, so the upgrade path exists and costs nothing today |
| 59 new keys × 12 locales = 708 real translations | The dominant reason the surface is this small. Every string above earns its place and nine were cut by reusing existing keys |
| Narrowing an overlay rejection from re-fetched state can race | Every narrowed message is a hint; the absolute — "Nothing was sent" — rests on `abortAction` releasing the inputs, which is guaranteed on the refusal path and deliberately *not* claimed on the network-throw path |
| One extra `listActions` + `listOutputs` per activity window, plus one `listOutputs` and one `/admin/asset-state` per foreground | Token-holding mainnet wallets only. A BSV-only wallet runs none of it: `isMandalaAvailable(chain)` is the gate and it is checked before the hook does anything |
| `AmountInput`'s documented invariant is generalised | Its shape is preserved — still integer strings, never floats on the wire — only the denomination changes, and one line (`isFiat = asset == null && …`) makes every existing branch inert rather than entangled |
| A token row can never name a blinded sender | Deliberate. Under D2 a rotating face is worse than no face, and `counterpartyOf`'s txid fallback would draw one |

---

## 10. Explicitly out of scope

1. **No address rail for stablecoins (D4).** The output pkh is `hash160(B + kG)` — an ECDH product requiring the recipient's public identity key (`L/blinding.ts:137-143`) — and the overlay derives an output's owner from the decrypted linkage's `counterparty`, silently skipping outputs it cannot name (`OG/mandala/linkage.go:50-89`, `topic_manager.go:154-172`), which then fails conservation. Refused inline with a plain reason, never hidden.
2. **No `?asset=` in the `peerpay:` grammar and no QR change.** BRC-125 has no asset parameter; adding one costs a parser, a validator, a spoof surface and 12 more locale entries to remove one tap the payer must take anyway. Switching the QR to a bare key would drop `?sats=` and `&url=` and regress shipped BSV plumbing.
3. ~~No offline nearby token payments in v1~~ — reversed. The
   maintainer's settlement model (recipient submits, recursive σ_I walk-back,
   idempotent `/submit`, payer's own optional submit) makes offline nearby
   token payments the *design center*, not a deferred feature — see the
   offline-settlement-final spec in full. What remains genuinely out of scope
   for v1 is unchanged from the rest of this document: multi-issuer nearby
   sessions (item 4, unchanged) and any dApp-facing story beyond the
   permission module in §8 of the offline-settlement-final spec.
4. **No multi-issuer support in v1.** One configured overlay per chain; a nearby session naming a different `overlayUrl` is refused with a plain reason. The committed spec's per-frame endpoints (`:256, :445`) are the right long-run answer and the frame already carries them; v1 simply does not resolve two.
5. **No review/confirm screen on the handle rail.** The wallet sends directly from `PayCta`; a token-only confirm screen would mean two send doctrines in one app. The CTA naming the exact figure and asset is the confirmation.
6. **No per-asset drill-in screen.** The web demo's `AssetAccount`/`TransactionHistory`/`AlertBanners` are unreachable dead code (`HolderHome`'s `onSelect` is destructured `_onSelect` and never called). The sheet covers disclosure, the flows cover the work, the shared Activity list covers history.
7. **No stablecoin figure in the hero and no second `typography.display` element.** Two display figures on one view means the view has no focal point (`tokens.ts:52-58`), and the hero is the fee balance.
8. **No fiat rendering of a token, no portfolio total, no USD inferred from a ticker.** §6.1.
9. **No contacts port.** `mandala-contacts` is a second address book with its own basket and a `createAction` per save. The wallet already has identity search, the outbox and `counterpartyOf`.
10. **No token outbox / `OutgoingSection` rows.** The lib's `notifyJournal` + `reconcileNotifications` do that job for the same failure and D3 makes them durable. Two queues for one payment is worse than either.
11. **No accept/reject step on arrival.** A choice that changes nothing is a lie in a button.
12. **No "Return to issuer", no redeem UI.** Holder scope.
13. **No badges, verified chips, trust scores or per-asset palettes.** The regulated disclosure is one sentence of body text and four capability lines.
14. **No dev-mode pause bypass.** A production escape hatch around a compliance control.
15. **No push notifications or background-fetch channel.** The three existing drains are what BSV gets and what tokens get.
16. **No second `FlatList`, no filter chips, no per-asset CSV.** Invariant 19 exists for a reason; the main Export CSV gains two columns instead.
17. **No `settings.currency` entry for an asset.** `isFiatCurrency(x) = Boolean(x) && x !== 'BSV'` (`amountFormatHelpers.ts:26`) would format a token id as a fiat code. The asset is a per-payment axis, carried as a prop.
18. **No P2MKH threshold admin locks and no key rotation (D1).**

---

## 11. Open questions for the human

1. **Does toolbox-mobile 2.4.3 `createAction({options:{sendWith, acceptDelayedBroadcast:false}})` throw on broadcast failure, or only return `sendWithResults[].status:'failed'`?** L7 assumes the latter and checks it explicitly. If it also throws, the check is belt-and-braces; if it does neither, the "Sent" claim is unverifiable and the success overlay must render the not-broadcast tone unconditionally for tokens.
2. **Renaming `TokenPayment.recipientLinkage` → `admission` changes committed, test-pinned code** (`codec.ts:14-21`, `__tests__/localpay/codec.test.ts:234`, `verify.test.ts:209-258`). The justification is that a payee-decryptable linkage is impossible under D2 without leaking the payer's real key `A` (BRC-72 decryption by the named verifier requires `counterparty: prover`), and the overlay's σ_I is strictly stronger evidence at a tenth the size. Confirm this is an acceptable break of the committed frame, or say whether the payee-linkage guarantee must be preserved some other way.
3. ~~Submitting to the overlay before hand-over deviates from the committed
   spec §4 step 6. It is what makes the "credited then refused" state
   impossible in v1. Confirm.~~ **RESOLVED, not open.** Superseded: the
   maintainer's own settlement model is the answer, and it is the opposite of
   what was asked — hand-over happens **before** any submit, unconditionally.
4. **`ADMIN_ORIGINATOR` for the lib.** It removes the spending sheet per send, the vault guard's external path, the `limit ≤ 500` denial and the per-mutation inventory scan, at the price of full admin authority — the same authority the wallet's own rails hold. Confirm this is the intended trust posture rather than a dedicated originator with a granted spending token.
5. **Where do `overlayUrl` / `overlayIdentityKey` / `messageBoxUrl` live?** This design adds them to `ToolboxServiceConfig` per chain and refuses cross-overlay nearby sessions. Confirm, or specify the per-asset resolution the committed spec's `SessionAsset` implies.
6. **Message-box host mismatch (§5.5).** Is the `ConsequenceNote` warning enough for v1, or should the wallet force its Mandala host independently of `message_box_url`?
7. ~~`'mandala-tokens'` is a non-admin basket with every
   `seekBasket*Permission` set `false`~~ (`WalletPermissionsManager.js:3597-3603`;
   `WalletContext.tsx:1272-1274`), so a paired dApp can list, insert into and
   relinquish token outputs unprompted. The Asset sheet's footer does not
   mention it. ~~Is that a v1 disclosure gap to close, or an accepted
   exposure?~~ **RESOLVED:** closed, not accepted — §8 of the
   offline-settlement-final spec (rename to `'p mandala'`, add
   `MandalaTokenModule`).
8. **`46 new keys × 12 locales = 552 real translations` in the same commit.** Is that budget available, and are there strings above you would cut?
9. **Does `tx.verify()` in `L/metadata.ts:35` succeed on device against WoC mainnet without an API key at realistic rates?** L5 proposes injecting the wallet's `OfflineFirstChaintracks` instead.
10. **RN `fetch` with a `Uint8Array` body to `/submit`** is a supported path (`convertRequestBody.js:37-41` base64 bridge) but has not been exercised against an overlay from a device.
11. **Which `version` does toolbox-mobile `createAction` emit by default?** Relevant to the Chronicle / low-S note; the lib never sets one.
12. **Jest configuration is required work this design assumes but does not detail:** `@bsv/mandala` needs a `transformIgnorePatterns` allowlist entry in `WR/package.json` **and** either a `moduleNameMapper` or the `default` export condition from L2. Two new screens' worth of tests cannot run until it lands.
