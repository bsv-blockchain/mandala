# Mandala

A **regulated stablecoin platform** on BSV: a self-hosted overlay that polices
token registration, issuance, transfer, redemption, and regulatory controls,
paired with a React frontend for the **issuer console** (admin) and a
**holder wallet** (neobank-style) UI.

Every state change is a real on-chain BSV transaction. The overlay indexes and
enforces admissible transactions; MessageBox handles peer-to-peer handoff so
recipients can claim what was sent.

**Built on:** BRC-100 identity protocol. The TS overlay runs @bsv/overlay v2.6.2,
@bsv/overlay-express v2.7.3, @bsv/sdk v2.8.11, @bsv/overlay-topics v1.6.0 and
@bsv/templates v1.9.0 (requires Node 24). The app and `lib/` are still on
@bsv/sdk v2.1.6 with @bsv/templates v1.9.0. The Go overlay (`overlay-go/`) runs
go-overlay-services v1.3.7 and go-sdk v1.7.1 on Go 1.26.

---

## Architecture Overview

- **Overlay Service** (`overlay/`): OverlayExpress instance on localhost:8080
  running the `tm_mandala` topic manager and `ls_mandala` lookup service.
  MongoDB stores tokens, key-linkage records, asset admin state and history;
  SQLite caches engine transactions/outputs. Exposes custom admin read
  endpoints (asset state, admin history, aggregated supply summary, and an
  overlay-wide activity feed with linkage-proven counterparties).
  A Go port lives in `overlay-go/` (see that package’s README).
- **App Frontend** (`app/`): React/Vite SPA, role-gated by wallet identity.
  - **Issuer console** (`/issuer/:section`) — sidebar sections: **Overview**
    (KPIs, admin history, register-asset strip), **Treasury** (issuer's own
    balance, send/receive), **Operations** (issue/redeem + regulatory
    controls), **Activity** (overlay-wide transaction feed), **Banking**
    (simulated bank transfers + reserve reconciliation).
  - **Holder wallet** — accounts overview, per-asset account with send/receive/
    history, contacts, QR receive.
- **Token client** (`lib/`): `@bsv/mandala` — send, receive, and administer
  assets with overlay-first commit and journaled recovery.
- **Token Flows**: Register asset (genesis outpoint = assetId) → Issue →
  Transfer (per-output `revealSpecificKeyLinkage` proves counterparties to the
  overlay) → Receive (MessageBox internalize) → Redeem (burn) →
  Freeze/Reissue (regulatory recovery, supply-conserving).

---

## Quick Start

### 1. Start the Overlay Service

Requires Node 24 (`overlay/package.json` engines: `>=24 <25`).

```bash
cd overlay
npm install
npm run gen-key
```

npm 12 and later skip dependency install scripts unless `package.json`
approves them. `overlay/package.json` approves the `sqlite3` install script
(`allowScripts`), so `npm install` builds its native binding; check with
`node -e "require('sqlite3')"`. A `sqlite3` version bump needs a fresh approval
(see `runbook.md`).

This prints:
```
SERVER_PRIVATE_KEY: <private_key>
IDENTITY_PUBLIC_KEY: <public_key>
```

Save the output. Copy `.env.example` → `.env` and paste the `SERVER_PRIVATE_KEY`:

```bash
cp .env.example .env
# Edit .env, replace SERVER_PRIVATE_KEY with the output above
```

Start the overlay and MongoDB:

```bash
docker compose up --build
```

Verify it's running:

```bash
curl http://localhost:8080/health
```

You should get a JSON health report: HTTP 200 once the overlay is ready, 503
before that. `curl http://localhost:8080/listTopicManagers` lists `tm_mandala`
and `tm_mandala_registry`.

### 2. Start the Frontend App

In a new terminal:

```bash
cd app
npm install
cp .env.example .env
```

Edit `app/.env` and set:
- `VITE_OVERLAY_IDENTITY_KEY`: the `IDENTITY_PUBLIC_KEY` from step 1
- `VITE_OVERLAY_URL`: `http://localhost:8080`
- `VITE_MESSAGEBOX_URL`: `https://messagebox.babbage.systems` (or your own MessageBox instance)

Run the dev server:

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

### 3. Connect Your Wallet

The app requires a **BRC-100 (MetaNet) wallet** running locally. When the
wallet's identity key matches `VITE_OVERLAY_IDENTITY_KEY`, the app renders the
**issuer console**; any other wallet gets the **holder wallet** UI.

---

## The Issuer Console

Navigate between sections in the left sidebar; the selected asset lives in the
URL (`?asset=`) so a reload restores exactly where you were.

### Overview

KPI tiles (in circulation, net issued, reserve ratio, restrictions) computed
from the overlay's aggregated supply summary, the ordered admin-action history
(virtualized, infinite scroll), and the **Register a new asset** strip in the
top bar (label, ticker, decimals → one genesis tx; its outpoint becomes the
assetId).

### Treasury

The issuer's own holdings of the selected asset: balance card and
Send / Receive tabs (the same flows a holder uses, locked to the asset).

### Operations

- **Issue tokens** — mint new units into circulation (optionally referencing a
  bank deposit ref from the Banking page).
- **Redeem tokens** — burn units out of circulation.
- **Regulatory controls** — pause/unpause transfers, block/allow identities,
  set access mode (denylist/allowlist), freeze/unfreeze outputs, and **reissue**
  from a frozen output (supply-conserving recovery: the frozen coin is evicted
  and replacement units are minted to the rightful owner).

### Activity

The **overlay-wide transaction feed** — every transaction admitted by the
overlay for the asset, with sender and recipient identities proven by the key
linkage revealed at submission. Each row is a semantic summary (issued /
transfer A→B / self / redeemed, with net units moved) plus a linkage-proof
badge. This is the operator’s oversight surface: not just the issuer’s own
transfers, but every party to every movement of the asset. Cursor-paginated
and virtualized — it stays snappy at thousands of transactions.

### Banking

A bank feed for reserve reconciliation: add incoming/outgoing transfers per
asset (persisted locally, deletable), and a reconciliation view comparing the
bank balance to net on-chain supply, flagging drift with guidance to issue or
redeem.

---

## Holder Operations

### Receive a Transfer

1. **Receive** shows your identity key as a QR code, plus pending inbound
   transfers from the message box.
2. **Accept** internalizes the tokens into your wallet basket; balance updates
   immediately.

### Send Tokens

1. **Send** — search recipients by name/@handle/email, pick a recent contact,
   paste an identity key (one field handles all three), or use the
   **Return to issuer** shortcut.
2. Amount keypad → review → send. The overlay validates conservation,
   key linkage, sanctions, pause state and access mode before admitting.
3. The recipient is notified via MessageBox.

### History

Per-asset transaction table (type, counterparty, amount, txid) with CSV
export. Counterparty identity keys resolve to names/avatars where the identity
network knows them.

---

## Overlay Admin Endpoints

Custom read endpoints registered by `overlay/src/index.ts` (all CORS-open for
local development):

| Endpoint | Purpose |
|---|---|
| `GET /admin/asset-state/:assetId` | Derived `AssetAdminState` (paused, access mode, blocked/allowed identities, frozen outpoints). |
| `GET /admin/admin-history/:assetId` | Full ordered admin-action history (used for CSV export). |
| `GET /admin/admin-history-page/:assetId?limit=&offset=` | Paged, newest-first admin history (drives the audit log UI). |
| `GET /admin/admin-summary/:assetId` | Aggregated `totalIssued` / `totalRedeemed` / `actionCount` (drives KPI + reconciliation math without shipping the full history). |
| `GET /admin/activity?assetId=&limit=&before=` | Cursor-paginated overlay-wide transaction feed with linkage-proven counterparties (see `overlay/src/activity.ts`). |

Mongo indexes backing the hot paths (`linkage.createdAt`,
`adminHistory.(assetId, admitSeq)`) are created at overlay boot.

---

## Manual End-to-End Verification Checklist

### Setup

- [ ] Overlay running on localhost:8080; `curl http://localhost:8080/health` returns 200.
- [ ] App running on localhost:5173 with `VITE_OVERLAY_IDENTITY_KEY` set to overlay's identity pubkey.
- [ ] Issuer wallet connected (identity key matches the overlay's).

### Registration & Issuance

- [ ] Issuer console renders (only when wallet identity === overlay identity).
- [ ] Overview → Register "Gold" (ticker GLD) → asset appears in the top-bar switcher; assetId is `<genesis_txid>.0`.
- [ ] Operations → Issue 100 → Overview "In circulation" shows 100; Treasury balance shows 100.
- [ ] Activity page shows the issuance (`Issued +100`, minted → issuer identity).

### Transfer & Receive

- [ ] Connect a **second wallet** (different identity) — it gets the holder UI, no issuer console.
- [ ] Issuer: Treasury → Send 40 to the second wallet's identity.
- [ ] Second wallet: Receive shows 40 pending → Accept → balance 40.
- [ ] Issuer Treasury balance 60 (change).
- [ ] Activity page shows the transfer as `Transfer 40` from issuer to recipient (change output not shown — it's a technical detail).
- [ ] Second wallet sends 10 back → issuer accepts → balances 30 / 70.

### Redeem

- [ ] Operations → Redeem 20 → Overview "In circulation" drops to 50; Activity shows `Redeemed −20`.

### Regulatory Controls

- [ ] Operations → Pause → second wallet's send is rejected by the overlay (frontend guard bypassable via the Dev toggle to prove server-side enforcement).
- [ ] Freeze one of the second wallet's outpoints → that coin cannot be spent.
- [ ] Reissue from the frozen outpoint to the same identity → replacement units arrive; audit log records `freezeOutput` then `reissue`.

### Banking Reconciliation

- [ ] Banking → add incoming transfer 50 → reconciliation shows drift (bank 50 vs supply) with guidance.
- [ ] Issue 50 from Operations → reconciliation shows "Reconciled — 100%".

---

## Running Tests

```bash
cd app && npm run test        # component, lib and flow tests (Vitest)
cd overlay && npm run test    # activity feed classifier + pagination tests
```

Both suites must pass. Typecheck with `npx tsc --noEmit` in either package.

---

## Environment Variables

### Overlay (`overlay/.env`)

```env
NODE_NAME=mandala
SERVER_PRIVATE_KEY=<output_from_npm_run_gen-key>
HOSTING_URL=http://localhost:8080
MONGO_URL=mongodb://mongodb:27017/mandala
NETWORK=main                # or test
SQLITE_FILE=/data/overlay.sqlite
# Optional — makes the overlay a full network participant (broadcast + SPV):
# ARCADE_URL=<arcade host>
# ARCADE_API_KEY=<key>
# ARCADE_CALLBACK_TOKEN=<32+ bytes; required with ARCADE_URL, and HOSTING_URL must then be an https:// origin (no path)>
# CHAINTRACKS_URL=<defaults to $ARCADE_URL/chaintracks>
```

Without `ARCADE_URL` the overlay validates scripts only and the wallet is the
sole broadcaster (local development mode).

### App (`app/.env`)

```env
VITE_OVERLAY_URL=http://localhost:8080
VITE_OVERLAY_IDENTITY_KEY=<IDENTITY_PUBLIC_KEY_from_overlay_gen-key>
VITE_MESSAGEBOX_URL=https://messagebox.babbage.systems
```

---

## Key Dependencies

- **@bsv/sdk** `^2.8.11` in the overlay, `^2.1.6` in the app and `lib/` — core blockchain and transaction utilities.
- **@bsv/templates** `^1.9.0` — `MandalaToken` / `MandalaAdmin` script templates. App and overlay MUST run the same version (assetId byte-order encoding must agree).
- **@bsv/overlay** `^2.6.2` — overlay engine + Knex/Mongo storage.
- **@bsv/overlay-express** `^2.7.3` — Express host for the overlay HTTP API.
- **@bsv/overlay-topics** `^1.6.0` — `tm_mandala` topic manager + `ls_mandala` lookup service + `MandalaStorageManager`.
- **@bsv/identity-react** `^1.1.14` — identity resolution hooks.
- **@bsv/message-box-client** `^2.2.0` — peer-to-peer transfer handoff.
- **React 19 / Vite 6 / Tailwind CSS 4** — frontend stack.
- **@tanstack/react-query + react-virtual** — cached/paged data fetching and virtualized lists.

---

## Troubleshooting

### Overlay won't start

- Ensure Docker and Docker Compose are installed and running.
- Check `docker compose logs mongodb` for MongoDB errors.
- Verify `.env` has the correct `SERVER_PRIVATE_KEY` (no leading/trailing whitespace).
- Clear volumes: `docker compose down -v && docker compose up --build`.

### App won't connect to overlay

- Verify `VITE_OVERLAY_URL=http://localhost:8080`.
- Check overlay is running: `curl http://localhost:8080/health`.
- Clear browser cache and restart dev server.

### Issuer console not appearing

- Ensure wallet identity key matches overlay's `IDENTITY_PUBLIC_KEY` (from `npm run gen-key`).
- Check `app/.env` has correct `VITE_OVERLAY_IDENTITY_KEY`.

### `overlay rejected the transaction` after a dependency bump

- A stale Vite pre-bundle cache can serve an old `@bsv/templates` after a bump,
  causing an assetId encoding mismatch → conservation failure. Fix:
  `rm -rf app/node_modules/.vite` and restart the dev server.

### Transfer not appearing in Receive

- Confirm both wallets are connected and running.
- Check overlay logs: `docker compose logs overlay`.
- Refresh the Receive tab.

---

## Architecture Notes

### Role Gating

The issuer console appears **only when** the connected wallet's identity key
equals the overlay's identity key. Everyone else gets the holder wallet. Only
the token authority can mint, redeem, pause, freeze or reissue.

### Transfer Linkage & Operator Oversight

Every FT output submitted to the overlay carries a `revealSpecificKeyLinkage`
proof binding it to a controlling identity key. The overlay verifies the proof
before admission and retains the linkage record permanently — this is what
powers sanctions screening, access-mode enforcement, and the issuer's
**Activity** page (sender/recipient per transaction, derived by walking each
input back to its linkage-proven source output).

### Supply Conservation

Per asset, the overlay only admits transactions where
`outputs == inputs + authorizedIssuance`. Minting balances only because the
issuer's admin-authorized `+amount` is present; redemption is negative
issuance; a `reissue` mints replacement units while evicting the frozen coin
from the overlay's balance view, keeping net supply constant.

### MessageBox Integration

Pending transfers are delivered as MessageBox entries. The recipient's wallet
calls `internalizeAction` to accept, which inserts the output into its basket
and updates the balance.

---

## License

Mandala is part of the BSV Mandala Token stack. Refer to `docs/` for detailed
architecture (`docs/PROJECT-STATE.md`) and operator documentation
(`docs/STABLECOIN-ADMIN.md`).
