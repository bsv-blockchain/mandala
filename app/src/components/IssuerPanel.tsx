import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Hash, Utils } from '@bsv/sdk'
import { parseAmount } from '@bsv/mandala/amount'
import { useAdminAssets } from '../hooks/useAdminAssets'
import { useIssuerMutations } from '../hooks/useIssuerMutations'
import { useHolderData } from '../hooks/useHolderData'
import { guardIssueSubmit, guardRedeemSubmit } from '@bsv/mandala/submitGuards'
import { isAdminAuthInFlight } from '@bsv/mandala/adminAuthGate'
import { Sparkles, Flame } from 'lucide-react'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { Button } from './ui/button'
import { Spinner } from './ui/spinner'

interface IssuerPanelProps {
  /** When set, sync to issue/redeem asset selection and hide per-section dropdowns. */
  assetId?: string
}

export default function IssuerPanel({ assetId: controlledAssetId }: IssuerPanelProps = {}) {
  const [issueAsset, setIssueAsset] = useState('')
  const [issueAmount, setIssueAmount] = useState('')
  const [redeemAsset, setRedeemAsset] = useState('')
  const [redeemAmount, setRedeemAmount] = useState('')

  // Deposit reference backing an issuance. Hashed client-side (sha256) before
  // it leaves the panel, so the bank record stays off-chain while the issue
  // commits to it as `bankRef` (R12 "commits a hash of the deposit record").
  const [issueRef, setIssueRef] = useState('')
  // Settlement note is display-only (not passed to any core function).
  const [redeemNote, setRedeemNote] = useState('')

  // Shared cached admin-asset list; mutations invalidate it on settle.
  const { data } = useAdminAssets()
  const assets = data ?? []
  const { data: holderData } = useHolderData()
  const { issue, redeem } = useIssuerMutations()
  // Issue/Redeem are independent actions — only the pressed button shows its
  // spinner, but both stay mutually exclusive. Sync refs block double-click
  // before isPending re-renders; adminAuthGate serializes wallet work.
  const busy = issue.isPending || redeem.isPending
  const issueStartedRef = useRef(false)
  const redeemStartedRef = useRef(false)

  // When controlled assetId changes, sync it into each section's selection
  useEffect(() => {
    if (controlledAssetId == null) return
    setIssueAsset(controlledAssetId)
    setRedeemAsset(controlledAssetId)
  }, [controlledAssetId])

  // Effective asset ids: controlled prop takes precedence over internal state
  const effectiveIssueAsset = controlledAssetId ?? issueAsset
  const effectiveRedeemAsset = controlledAssetId ?? redeemAsset

  const handleIssue = () => {
    if (issueStartedRef.current || busy) return
    const asset = assets.find(a => a.assetId === effectiveIssueAsset)
    if (asset == null) return
    if (isAdminAuthInFlight(asset.assetId)) {
      toast.error('Admin action already in progress for this asset')
      return
    }
    const amount = parseAmount(issueAmount, Number(asset.metadata?.decimals) || 0)
    const ref = issueRef.trim()
    const depositHash = ref === '' ? undefined : Utils.toHex(Hash.sha256(Utils.toArray(ref, 'utf8')))
    const gate = guardIssueSubmit({
      assetId: asset.assetId,
      amount,
      bankRef: depositHash,
      walletReady: true
    })
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    issueStartedRef.current = true
    issue.mutate(
      { asset, amount, depositHash },
      {
        onSuccess: () => { setIssueAmount(''); setIssueRef('') },
        onSettled: () => { issueStartedRef.current = false }
      }
    )
  }

  const handleRedeem = () => {
    if (redeemStartedRef.current || busy) return
    const asset = assets.find(a => a.assetId === effectiveRedeemAsset)
    if (asset == null) return
    if (isAdminAuthInFlight(asset.assetId)) {
      toast.error('Admin action already in progress for this asset')
      return
    }
    const amount = parseAmount(redeemAmount, Number(asset.metadata?.decimals) || 0)
    const held = holderData?.assets.find(a => a.assetId === asset.assetId)?.balance
    const gate = guardRedeemSubmit({
      assetId: asset.assetId,
      amount,
      balance: held,
      walletReady: true
    })
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    redeemStartedRef.current = true
    redeem.mutate(
      { asset, amount },
      {
        onSuccess: () => setRedeemAmount(''),
        onSettled: () => { redeemStartedRef.current = false }
      }
    )
  }

  const assetOptions = (
    <>
      <option value="">Select…</option>
      {assets.map(a => (
        <option key={a.assetId} value={a.assetId}>{a.label}</option>
      ))}
    </>
  )

  // Shared input style
  const inputCls = 'bg-muted border border-border rounded px-[13px] py-[11px] text-[13px] text-subtle-foreground placeholder:text-subtle-foreground w-full'
  const labelCls = 'block text-[11px] font-medium text-subtle-foreground mb-[7px]'

  return (
    <div className="space-y-5">
      {/* Page heading */}
      <div className="mb-1">
        <h1 className="text-[27px] font-semibold tracking-[-0.5px] leading-tight">
          Operations
        </h1>
        <p className="text-subtle-foreground text-[13.5px] mt-1">
          Mint, redeem &amp; regulatory controls
        </p>
      </div>

      {/* Issue + Redeem: 2-col grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Issue card */}
        <div className="bg-card border border-border rounded-md p-[18px] flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div
              className="grid h-9 w-9 shrink-0 place-items-center rounded bg-primary/10 text-primary"
            >
              <Sparkles className="h-[18px] w-[18px]" />
            </div>
            <div>
              <p className="text-[15px] font-semibold leading-tight">Issue tokens</p>
              <p className="text-[11.5px] text-subtle-foreground mt-0.5">Mint new tokens into circulation</p>
            </div>
          </div>

          <div className="space-y-3">
            {controlledAssetId == null && (
              <div>
                <label className={labelCls} htmlFor="issue-asset">Asset</label>
                <Select id="issue-asset" value={issueAsset} onChange={e => setIssueAsset(e.target.value)} className={inputCls}>
                  {assetOptions}
                </Select>
              </div>
            )}
            <div>
              <label className={labelCls} htmlFor="issue-amount">Amount</label>
              <Input
                id="issue-amount"
                type="number"
                min="0"
                step="any"
                value={issueAmount}
                onChange={e => setIssueAmount(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="issue-ref">Backed by (optional)</label>
              <Input
                id="issue-ref"
                type="text"
                value={issueRef}
                onChange={e => setIssueRef(e.target.value)}
                placeholder="Bank deposit ref · BR-…"
                className={inputCls}
              />
            </div>
          </div>

          <Button
            onClick={handleIssue}
            disabled={busy || effectiveIssueAsset === '' || issueAmount === ''}
            loading={issue.isPending}
            loadingText="Issuing…"
            className="w-full rounded bg-primary text-primary-foreground mt-auto"
          >
            Issue Tokens
          </Button>
        </div>

        {/* Redeem card */}
        <div className="bg-card border border-border rounded-md p-[18px] flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div
              className="grid h-9 w-9 shrink-0 place-items-center rounded bg-warning/10 text-warning"
            >
              <Flame className="h-[18px] w-[18px]" />
            </div>
            <div>
              <p className="text-[15px] font-semibold leading-tight">Redeem tokens</p>
              <p className="text-[11.5px] text-subtle-foreground mt-0.5">Burn tokens out of circulation</p>
            </div>
          </div>

          <div className="space-y-3">
            {controlledAssetId == null && (
              <div>
                <label className={labelCls} htmlFor="redeem-asset">Asset</label>
                <Select id="redeem-asset" value={redeemAsset} onChange={e => setRedeemAsset(e.target.value)} className={inputCls}>
                  {assetOptions}
                </Select>
              </div>
            )}
            <div>
              <label className={labelCls} htmlFor="redeem-amount">Amount</label>
              <Input
                id="redeem-amount"
                type="number"
                min="0"
                step="any"
                value={redeemAmount}
                onChange={e => setRedeemAmount(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="redeem-note">Settlement note (optional)</label>
              <Input
                id="redeem-note"
                type="text"
                value={redeemNote}
                onChange={e => setRedeemNote(e.target.value)}
                placeholder="e.g. wire returned to holder"
                className={inputCls}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleRedeem}
            disabled={busy || effectiveRedeemAsset === '' || redeemAmount === ''}
            className="w-full rounded mt-auto py-[10px] px-4 text-[13.5px] font-medium transition-opacity disabled:opacity-40 bg-background border border-destructive/40 text-destructive flex items-center justify-center gap-2"
          >
            {redeem.isPending && <Spinner size="sm" tone="current" />}
            {redeem.isPending ? 'Redeeming…' : 'Redeem (burn)'}
          </button>
        </div>
      </div>

      {/* Recovery of a frozen output lives in Regulatory → "Reissue from frozen
          output": it ties the minted amount to the frozen row and the overlay
          enforces conservation (reissue guard), so circulation can't drift. A
          free-form "recover" mint here could not guarantee that, so it's gone. */}

    </div>
  )
}
