/**
 * Shipped redeemTokens path — stale admin prior and amount-above-balance must
 * refuse before loadFtCandidates / createAction (no fuzzy partial work).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { redeemTokens } from './issuerOps.js'
import { clearAdminAuthGates } from './adminAuthGate.js'
import { StaleAdminAuthError } from './adminAuthGate.js'
import type { AdminAsset } from './assets.js'

const asset: AdminAsset = {
  assetId: 'asset.0',
  label: 'USD',
  authOutpoint: 'auth-prior.0',
  authKeyID: 'deploy',
  metadata: { decimals: 0, label: 'USD', ticker: 'USD' }
}

beforeEach(() => {
  clearAdminAuthGates()
  vi.restoreAllMocks()
})

describe('redeemTokens pre-flight (shipped issuerOps)', () => {
  it('rejects amount above known balance without any wallet I/O', async () => {
    const wallet = {
      listOutputs: vi.fn(),
      listActions: vi.fn(),
      createAction: vi.fn(),
      signAction: vi.fn(),
      abortAction: vi.fn()
    }
    await expect(
      redeemTokens({
        wallet: wallet as any,
        identityKey: '02' + 'ab'.repeat(32),
        asset,
        amount: 50,
        balance: 40
      })
    ).rejects.toThrow(/exceeds available balance|greater than zero|valid/i)

    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects non-positive amount without wallet I/O', async () => {
    const wallet = {
      listOutputs: vi.fn(),
      listActions: vi.fn(),
      createAction: vi.fn()
    }
    await expect(
      redeemTokens({
        wallet: wallet as any,
        identityKey: '02' + 'ab'.repeat(32),
        asset,
        amount: 0
      })
    ).rejects.toThrow()
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('asserts spendable prior before FT coin selection when auth is stale', async () => {
    const listOutputs = vi.fn().mockResolvedValue({
      // Auth prior missing — only unrelated outputs present
      outputs: [{ outpoint: 'other.0' }],
      BEEF: [1, 2, 3]
    })
    const listActions = vi.fn().mockResolvedValue({ actions: [] })
    const wallet = {
      listOutputs,
      listActions,
      createAction: vi.fn(),
      signAction: vi.fn()
    }

    await expect(
      redeemTokens({
        wallet: wallet as any,
        identityKey: '02' + 'ab'.repeat(32),
        asset,
        amount: 10
      })
    ).rejects.toBeInstanceOf(StaleAdminAuthError)

    // First (and only needed) wallet call is the auth spendability list.
    expect(listOutputs).toHaveBeenCalled()
    // loadFtCandidates uses listActions for confirmation meta — must not run
    // after a stale-prior refusal.
    expect(listActions).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('lists auth basket before proceeding when prior is still spendable', async () => {
    // Stops at FT selection (empty candidates) — proves auth check passed first
    // and we only then enter loadFtCandidates (listActions).
    const listOutputs = vi.fn().mockImplementation(async (args: { include?: string }) => {
      if (args?.include === 'entire transactions') {
        return { outputs: [], BEEF: [] }
      }
      // Auth pre-check (no include entire transactions)
      return {
        outputs: [{ outpoint: asset.authOutpoint }],
        BEEF: undefined
      }
    })
    const listActions = vi.fn().mockResolvedValue({ actions: [] })
    const wallet = {
      listOutputs,
      listActions,
      createAction: vi.fn(),
      signAction: vi.fn()
    }

    await expect(
      redeemTokens({
        wallet: wallet as any,
        identityKey: '02' + 'ab'.repeat(32),
        asset,
        amount: 10
      })
    ).rejects.toThrow() // insufficient FT — expected after prior check

    // Auth list first, then loadFtCandidates path (listActions and/or further listOutputs)
    expect(listOutputs.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(listOutputs.mock.calls[0][0]).not.toEqual(
      expect.objectContaining({ include: 'entire transactions' })
    )
    // Reached coin-selection after prior was OK
    expect(listActions).toHaveBeenCalled()
  })
})
