import { describe, it, expect, vi, afterEach } from 'vitest'
import { OneColor } from '@bsv/templates'
import { parseActionsToHistory, exportTransactionsCsv, loadHistory } from './history.js'
import { MAX_UINT64 } from './amount.js'
import { assetTag } from './naming.js'
import { commitmentPayload } from './brc162.js'
import { TREASURY_BASKET } from './constants.js'

const ID = `${'ab'.repeat(32)}_0`
const OTHER = `${'cd'.repeat(32)}_0`
const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
const lock = (assetId: string, amount: bigint): string => new OneColor().lock(assetId, amount, PKH).toHex()
const authority = (assetId: string): string => new OneColor().lock(assetId, 0n, PKH, commitmentPayload([1])).toHex()
const BASKET = `p color ${assetTag(ID)}`
const SENDER = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const custody = (sender: string): string => JSON.stringify({
  version: 1, assetId: ID, derivationPrefix: 'cHJl', derivationSuffix: 'c3Vm', senderIdentityKey: sender
})

afterEach(() => { vi.restoreAllMocks() })

// Treasury actions as the issuer flows write them (labels 'mandala' + kind).
const treasury = [
  {
    txid: 't3',
    description: 'Issue tokens',
    isOutgoing: true,
    labels: ['mandala', 'issue'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'issued FT',
        basket: TREASURY_BASKET,
        satoshis: 1,
        spendable: true,
        tags: ['mandala', 'issued', 'y.0'],
        customInstructions: JSON.stringify({ keyID: 'k2', counterparty: '02holder', assetId: 'y.0' })
      }
    ]
  },
  {
    txid: 't4',
    description: 'Redeem 25 Test Dollar',
    isOutgoing: true,
    labels: ['mandala', 'redeem'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'redeem FT',
        basket: TREASURY_BASKET,
        satoshis: 1,
        spendable: false,
        tags: ['mandala', 'redeemed', 'y.0'],
        customInstructions: JSON.stringify({ keyID: 'k3', counterparty: '02issuer', assetId: 'y.0' })
      }
    ]
  }
]

// Holder actions as sendHandover / receiveHandovers write them.
const sendAction = {
  txid: 'send1',
  description: 'Mandala token payment',
  isOutgoing: true,
  labels: ['p color plan 0 1 deadbeef', 'mandala', 'transfer'],
  outputs: [
    { outputIndex: 0, satoshis: 1, lockingScript: lock(ID, 400n) },
    { outputIndex: 1, satoshis: 1, basket: BASKET, lockingScript: lock(ID, 600n), customInstructions: custody('02self') }
  ]
}
const receiveAction = {
  txid: 'recv1',
  description: 'Mandala token payment',
  isOutgoing: false,
  labels: ['mandala', 'receive'],
  outputs: [{ outputIndex: 0, satoshis: 1, basket: BASKET, lockingScript: lock(ID, 250n), customInstructions: custody(SENDER) }]
}

describe('parseActionsToHistory: treasury kinds', () => {
  it('classifies issue and redeem; redeem reads the description prefix', () => {
    const rows = parseActionsToHistory(treasury as any)
    const issued = rows.find(r => r.txid === 't3')!
    const redeemed = rows.find(r => r.txid === 't4')!
    expect(issued.direction).toBe('issued')
    expect(issued.assetId).toBe('y.0')
    expect(issued.kind).toBe('issue')
    expect(redeemed.direction).toBe('redeemed')
    expect(redeemed.assetId).toBe('y.0')
    expect(redeemed.kind).toBe('redeem')
    expect(redeemed.amount).toBe(25n)
  })

  it('an issue whose minted output decodes MAX_UINT64 reports it exactly', () => {
    const rows = parseActionsToHistory([{
      txid: 'big',
      labels: ['mandala', 'issue'],
      outputs: [
        { outputIndex: 0, lockingScript: authority(ID) },
        { outputIndex: 1, lockingScript: lock(ID, MAX_UINT64) }
      ]
    }] as any)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'issued', assetId: ID, amount: MAX_UINT64 })
    expect(exportTransactionsCsv(rows)).toContain('18446744073709551615')
  })

  it('issue sums above 2^64 exactly', () => {
    const rows = parseActionsToHistory([{
      txid: 'sum',
      labels: ['mandala', 'issue'],
      outputs: [{ outputIndex: 0, lockingScript: lock(ID, MAX_UINT64) }, { outputIndex: 1, lockingScript: lock(ID, MAX_UINT64) }]
    }] as any)
    expect(rows[0].amount).toBe(2n * MAX_UINT64)
  })

  it('a redeem with only an authority output takes its asset id from the authority', () => {
    const rows = parseActionsToHistory([{
      txid: 'r2',
      description: 'Redeem 18446744073709551615 Test Dollar',
      labels: ['mandala', 'redeem'],
      outputs: [{ outputIndex: 0, lockingScript: authority(ID) }, { outputIndex: 1, satoshis: 900 }]
    }] as any)
    expect(rows).toEqual([expect.objectContaining({ direction: 'redeemed', assetId: ID, amount: MAX_UINT64 })])
  })

  it('a redeem description outside the uint64 range reads 0, never throws', () => {
    const rows = parseActionsToHistory([{
      txid: 'r3',
      description: 'Redeem 18446744073709551616 x',
      labels: ['mandala', 'redeem'],
      outputs: [{ outputIndex: 0, lockingScript: authority(ID) }]
    }] as any)
    expect(rows[0].amount).toBe(0n)
  })

  it('skips a treasury action with no asset id', () => {
    const rows = parseActionsToHistory([{
      txid: 'bad',
      labels: ['mandala', 'pause'],
      outputs: [{ outputIndex: 0, tags: ['mandala'], customInstructions: JSON.stringify({ keyID: 'k' }) }]
    }] as any)
    expect(rows).toEqual([])
  })
})

describe('parseActionsToHistory: holder kinds', () => {
  it('a send reports the basket-less recipient output, never the module change; plan labels do not set the kind', () => {
    const rows = parseActionsToHistory([sendAction] as any)
    expect(rows).toEqual([expect.objectContaining({ txid: 'send1', direction: 'sent', kind: 'transfer', amount: 400n, assetId: ID, counterparty: '' })])
  })

  it('a receive sums the p color outputs and reads the custody senderIdentityKey', () => {
    const rows = parseActionsToHistory([receiveAction] as any)
    expect(rows).toEqual([expect.objectContaining({ txid: 'recv1', direction: 'received', kind: 'receive', amount: 250n, assetId: ID, counterparty: SENDER })])
  })

  it('a self-send whose output 0 is an owned p color output falls back to output 0', () => {
    const rows = parseActionsToHistory([{
      txid: 'self1',
      labels: ['mandala', 'transfer'],
      outputs: [
        { outputIndex: 1, basket: BASKET, lockingScript: lock(ID, 70n), customInstructions: custody('02me') },
        { outputIndex: 0, basket: BASKET, lockingScript: lock(ID, 30n), customInstructions: custody('02me') }
      ]
    }] as any)
    expect(rows).toEqual([expect.objectContaining({ direction: 'sent', amount: 30n, counterparty: '02me' })])
  })

  it('a send at MAX_UINT64 is exact', () => {
    const rows = parseActionsToHistory([{
      txid: 'maxsend',
      labels: ['mandala', 'transfer'],
      outputs: [{ outputIndex: 0, lockingScript: lock(ID, MAX_UINT64) }]
    }] as any)
    expect(rows[0].amount).toBe(MAX_UINT64)
  })

  it('skips holder actions that decode no value of one asset, with one warning per call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows = parseActionsToHistory([
      { txid: 'none', labels: ['mandala', 'transfer'], outputs: [{ outputIndex: 0, tags: ['mandala', 'x.0'] }] },
      { txid: 'two', labels: ['mandala', 'receive'], outputs: [
        { outputIndex: 0, basket: BASKET, lockingScript: lock(ID, 1n) },
        { outputIndex: 1, basket: `p color ${assetTag(OTHER)}`, lockingScript: lock(OTHER, 1n) }
      ] },
      { txid: 'nobasket', labels: ['mandala', 'receive'], outputs: [{ outputIndex: 0, lockingScript: lock(ID, 1n) }] },
      receiveAction
    ] as any)
    expect(rows.map(r => r.txid)).toEqual(['recv1'])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('loadHistory', () => {
  const issueAction = {
    txid: 'iss1',
    labels: ['mandala', 'issue'],
    outputs: [{ outputIndex: 0, lockingScript: lock(ID, 1000n) }]
  }
  const walletWith = (actions: unknown[]): any => ({
    listActions: vi.fn().mockResolvedValue({ totalActions: actions.length, actions }),
    listOutputs: vi.fn().mockResolvedValue({ outputs: [] })
  })

  it('holder scope: one listing labelled mandala (any), no basket listing, sent and received rows', async () => {
    const w = walletWith([issueAction, sendAction, receiveAction])
    const rows = await loadHistory(w, { scope: 'holder' })
    expect(rows).toMatchObject([
      { direction: 'sent', kind: 'transfer', amount: 400n, assetId: ID },
      { direction: 'received', kind: 'receive', amount: 250n, assetId: ID }
    ])
    expect(rows).toHaveLength(2)
    expect(w.listActions).toHaveBeenCalledTimes(1)
    expect(w.listActions.mock.calls[0][0]).toMatchObject({
      labels: ['mandala'], labelQueryMode: 'any', includeLabels: true, includeOutputs: true, includeOutputLockingScripts: true, limit: 1000
    })
    expect(w.listOutputs).not.toHaveBeenCalled()
  })

  it('treasury scope drops both holder rows and joins treasury customInstructions', async () => {
    const w = walletWith([issueAction, sendAction, receiveAction])
    const rows = await loadHistory(w, { scope: 'treasury' })
    expect(rows.map(r => r.txid)).toEqual(['iss1'])
    expect(rows[0].amount).toBe(1000n)
    expect(w.listOutputs).toHaveBeenCalledWith(expect.objectContaining({ basket: TREASURY_BASKET, includeCustomInstructions: true }))
  })

  it('default scope returns treasury and holder rows; assetId filters', async () => {
    const w = walletWith([issueAction, sendAction, receiveAction])
    expect((await loadHistory(w)).map(r => r.txid)).toEqual(['iss1', 'send1', 'recv1'])
    expect(w.listOutputs).toHaveBeenCalledTimes(1)
    expect(await loadHistory(w, { assetId: OTHER })).toEqual([])
    expect((await loadHistory(w, { assetId: ID, scope: 'holder' })).map(r => r.txid)).toEqual(['send1', 'recv1'])
  })

  it('never lists a p color basket', async () => {
    const w = walletWith([sendAction, receiveAction])
    await loadHistory(w)
    for (const [args] of w.listOutputs.mock.calls) expect(String(args.basket).startsWith('p color')).toBe(false)
  })
})

describe('exportTransactionsCsv', () => {
  it('CSV has a header and one row per history entry', () => {
    const rows = parseActionsToHistory([...treasury, sendAction, receiveAction] as any)
    const csv = exportTransactionsCsv(rows)
    const lines = csv.split('\n')
    expect(lines).toHaveLength(rows.length + 1) // header + N data rows
    expect(lines[0]).toContain('txid')
    expect(lines[0]).toContain('direction')
    expect(lines[0]).toContain('counterparty')
  })

  it('escapes double quotes in CSV fields', () => {
    const rows = [
      {
        txid: 'tx-"quoted"',
        assetId: 'a.0',
        direction: 'sent' as const,
        amount: 0n,
        counterparty: 'addr"with"quotes',
        when: 0,
        kind: 'transfer'
      }
    ]
    const csv = exportTransactionsCsv(rows)
    expect(csv).toContain('"tx-""quoted"""')
    expect(csv).toContain('"addr""with""quotes"')
  })

  it('handles empty rows', () => {
    const csv = exportTransactionsCsv([])
    const lines = csv.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('txid')
  })
})
