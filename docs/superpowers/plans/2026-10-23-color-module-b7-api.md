# @bsv/color-permission-module 0.2.0 public API after Amendment B7

ts-stack branch `feat/1color-profiles` (PR #1334), commits `16215f652`, `222ef9f76`, `6f9323f07` (unpushed).
`@bsv/sdk` is no longer touched by the PR. Receipts are plain BRC-207 custody JSON of at most 1000
bytes. The module transports and validates no token history.

## Exports (`src/index.ts`)

Runtime values:

- `ColorPermissionModule`, `createColorModule(options)`
- Evaluation helpers: `actionConsent`, `assertPlanAssets`, `assertTransactionOperations`,
  `assertUnlocks`, `authorityOperation`, `deployOperation`, `readSentToken`, `requiredOperations`,
  `sighashScopes`, `submissionAssets`, `supplyChange`, `tokenSources`, `transactionConsent`,
  `transactionTokens`, `tryReadTokenOutput`
- Token readers: `UnsupportedProfileError`, `assertNoRequiredProfiles`, `readAnyTokenOutput`,
  `readJsonTokenOutput`, `readProfiledTokenOutput`, `readTokenOutput`
- Errors: `ColorConsentDeclinedError`, `ProfileDataError`, `ProfileParamsError`
- Plan codec: `ColorPlan`, `COLOR_PLAN_LABEL_PREFIX`, `COLOR_OPERATIONS`
- Identifiers: `ASSETS_SELECTOR`, `COLOR_KEY_ID`, `COLOR_OFFLINE_TAG` (`'color_offline'`), `ISSUE`,
  `assetBasket`, `assetTag`, `colorProtocolID`, `colorTopic`, `parseAssetBasket`,
  `parseBalanceSelector`, `parseColorProtocolID`

Types: `ActionConsentOptions`, `Custody`, `Holding`, `ManagedInput`, `ReleasedSignature`,
`SourceOutput`, `TransactionConsentOptions`, `TransactionTokens`, `JsonOperation`, `TokenOutput`,
`TokenReader`, `ColorOperation`, `ColorOperationName`, `ColorRemittance`, `TokenRole`,
`ColorModuleStore`, `ColorOverlayProvider`, `ColorPermissionModuleOptions`,
`ColorTokenAccessHandler`, `ProfileData`, `ProfileAssetContext`, `ProfileDescriptor`,
`ProfileReceipt`, `ProfileTxView`, `ReceiptAdmission`, `RequiredProfileHandler`, `JsonValue`.

Removed relative to the previous 0.2.0 candidate: `createAttestedProfile`, `ATTESTED_PROFILE_ID`,
`ATTESTATION_PROTOCOL_ID`, `ATTESTATION_KEY_ID`, `attestationMessage`, `attestationSigningKey`,
`parseAttestation`, `verifyAttestation`, `attestationFromSteak`, `AttestationEvidenceError`,
`ColorProviderError`, the types `AttestedAdmittance`, `AttestedSTEAK`, `ColorAttestation`,
`ColorHandoffResult`, `ColorSettleReport`, `ColorSettleResult`, `ReceiptGraph`, and the module
methods `settle()`, `isSettled()`, `handoffEvidence()`. `ColorOverlayProvider.submit` returns
`STEAK` again. `COLOR_OFFLINE_TAG` now comes from the identifiers module.

## Module object (host only)

```ts
class ColorPermissionModule {
  readonly capabilities: Readonly<Record<string, string>> // { 'brc207-color': '4' }
  dispose(): void
  /**
   * In process, not a BRC-100 method. Writes color.v1.settled.<txid> once (idempotent) to the
   * host's ColorModuleStore; views then hide color_offline for that transaction's outputs.
   * No-op without profiles; a non-lowercase-hex txid throws TypeError.
   */
  markSettled(txid: string): Promise<void>
  // PermissionsModule surface: handleRequest, onRequest, onResponse
}
```

## Handler contract

```ts
interface ProfileAssetContext {
  assetId: string
  profileId: string
  descriptor: ProfileDescriptor // { version: number; params: StrictCborValue }
  req: ReadonlyMap<string, ProfileDescriptor>
  declarationTx: Transaction
  wallet: WalletInterface // the underlying wallet
  identityKey: string
  originator: string
}

interface ProfileReceipt {
  assetId: string
  txid: string
  outputIndex: number
  tx: Transaction
  beef: number[] // the internalizeAction tx bytes (AtomicBEEF) as supplied
}

interface ReceiptAdmission {
  credit: 'settled' | 'pending'
}

interface RequiredProfileHandler {
  readonly id: string
  readonly versions: readonly number[]
  checkDescriptor: (descriptor: ProfileDescriptor, req: ReadonlyMap<string, ProfileDescriptor>) => void
  provider?: (assetId: string, descriptor: ProfileDescriptor) => ColorOverlayProvider
  deployProviders?: () => ColorOverlayProvider[]
  readonly sendPolicy?: 'plain-nosend'
  readonly operations?: readonly ColorOperationName[]
  checkPlanData?: (ctx: ProfileAssetContext, leaf: JsonValue | undefined, view: ProfileTxView) => Promise<void>
  submissionData?: (ctx: ProfileAssetContext, view: ProfileTxView) => Promise<number[]>
  admitReceipt?: (ctx: ProfileAssetContext, receipt: ProfileReceipt) => Promise<ReceiptAdmission>
  checkExt?: (value: StrictCborValue | undefined) => void
}
```

Removed members: `checkReceiptData`, `maxReceiptBytes`; `admitReceipt` no longer takes a
`ReceiptGraph` and no longer needs the attested profile.

## Behaviour the Mandala side relies on

- Registry fails closed: every profile in a deploy's `req` must be registered with its version,
  otherwise `UnsupportedProfileError`; at most one handler per asset may define `submissionData`, and
  at most one `admitReceipt`.
- `admitReceipt` runs once per receipt output, in order, after custody/basket/ownership/deploy
  conformance, and replaces the overlay spendability check for that asset. A throw credits nothing.
  Any answer other than `{credit:'settled'|'pending'}` fails with `ProfileDataError`. `pending`
  forwards the insertion with `color_offline` appended to the caller's (non-`color_`) tags.
- Any non-empty receipt `profileData` fails with the 0.1.0 plain `Error` ("...profileData names a
  profile the asset does not require"), with or without profiles; an empty `{}` is accepted as in
  0.1.0. The wallet always gets the 5-member custody JSON.
- `plain-nosend`: `options.noSend` required, no BRC-177 label, only plain-nosend assets in the
  action (several are allowed now). Change stays in the tx tagged `color_offline`. signAction
  forces `noSend: true, sendWith: []`, refuses `noSend:false`/`sendWith`, and `onResponse` never
  submits and returns the wallet result unchanged (no `colorHandoff`). `submissionData` is not
  called for a plain hand-over.
- A `color_offline` output is spendable only once its overlay lists it; the module never
  resubmits outputs of assets whose profiles declare `sendPolicy` or `submissionData`. So a
  plain-noSend hand-over needs the overlay reachable at createAction/signAction, and pending change
  cannot fund a further hand-over until the host submitted it and the overlay admitted it.
- Pending balance: `listOutputs({ basket: 'p color balance <assetTag>', tags: ['color_offline'] })`.
