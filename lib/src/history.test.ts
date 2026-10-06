import { describe, it, expect } from 'vitest'
import { MandalaToken } from './__fixtures__/token.js'
import { parseActionsToHistory, exportTransactionsCsv } from './history.js'

// Real MandalaToken locking script (decodable), arbitrary pkh.
// assetId must be outpoint-shaped: 64-hex txid + '.' + vout.
const ASSET = `${'ab'.repeat(32)}_0`
const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
const ftScript = (assetId: string, amount: number): string =>
  new MandalaToken().lock(assetId, amount, PKH).toHex()

const actions = [
  {
    txid: 't1',
    description: 'Send tokens',
    satoshis: 0,
    status: 'completed',
    isOutgoing: true,
    version: 1,
    lockTime: 0,
    labels: ['mandala', 'transfer'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'FT to recipient',
        basket: 'mandala',
        satoshis: 1,
        spendable: false,
        tags: ['mandala', 'sent', 'x.0'],
        customInstructions: JSON.stringify({
          keyID: 'k',
          counterparty: '02recip',
          direction: 'sent',
          recipient: '02recip',
          assetId: 'x.0'
        })
      }
    ]
  },
  {
    txid: 't2',
    description: 'Receive tokens',
    satoshis: 0,
    status: 'completed',
    isOutgoing: false,
    version: 1,
    lockTime: 0,
    labels: ['mandala', 'receive'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'received FT',
        basket: 'mandala',
        satoshis: 1,
        spendable: true,
        tags: ['mandala', 'received', 'x.0'],
        customInstructions: JSON.stringify({
          keyID: 'k',
          counterparty: '02sender',
          assetId: 'x.0'
        })
      }
    ]
  },
  {
    txid: 't3',
    description: 'Issue tokens',
    satoshis: 0,
    status: 'completed',
    isOutgoing: true,
    version: 1,
    lockTime: 0,
    labels: ['mandala', 'issue'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'issued FT',
        basket: 'mandala',
        satoshis: 1,
        spendable: true,
        tags: ['mandala', 'issued', 'y.0'],
        customInstructions: JSON.stringify({
          keyID: 'k2',
          counterparty: '02holder',
          assetId: 'y.0'
        })
      }
    ]
  },
  {
    txid: 't4',
    description: 'Redeem tokens',
    satoshis: 0,
    status: 'completed',
    isOutgoing: true,
    version: 1,
    lockTime: 0,
    labels: ['mandala', 'redeem'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'redeem FT',
        basket: 'mandala',
        satoshis: 1,
        spendable: false,
        tags: ['mandala', 'redeemed', 'y.0'],
        customInstructions: JSON.stringify({
          keyID: 'k3',
          counterparty: '02issuer',
          assetId: 'y.0'
        })
      }
    ]
  },
  {
    txid: 't5',
    description: 'Transfer receive side',
    satoshis: 0,
    status: 'completed',
    isOutgoing: false,
    version: 1,
    lockTime: 0,
    labels: ['mandala', 'transfer'],
    outputs: [
      {
        outputIndex: 0,
        outputDescription: 'FT received from sender',
        basket: 'mandala',
        satoshis: 1,
        spendable: true,
        tags: ['mandala', 'received', 'x.0'],
        customInstructions: JSON.stringify({
          keyID: 'k4',
          counterparty: '02sender2',
          direction: 'received',
          assetId: 'x.0'
        })
      }
    ]
  }
]

describe('parseActionsToHistory', () => {
  it('classifies sent vs received and extracts counterparty + assetId', () => {
    const rows = parseActionsToHistory(actions as any)
    const sent = rows.find(r => r.txid === 't1')!
    const recv = rows.find(r => r.txid === 't2')!
    expect(sent.direction).toBe('sent')
    expect(sent.counterparty).toBe('02recip')
    expect(sent.assetId).toBe('x.0')
    expect(recv.direction).toBe('received')
    expect(recv.counterparty).toBe('02sender')
  })

  it('classifies issue and redeem correctly', () => {
    const rows = parseActionsToHistory(actions as any)
    const issued = rows.find(r => r.txid === 't3')!
    const redeemed = rows.find(r => r.txid === 't4')!
    expect(issued.direction).toBe('issued')
    expect(issued.assetId).toBe('y.0')
    expect(redeemed.direction).toBe('redeemed')
    expect(redeemed.assetId).toBe('y.0')
  })

  it('classifies transfer receive side as received', () => {
    const rows = parseActionsToHistory(actions as any)
    const recv = rows.find(r => r.txid === 't5')!
    expect(recv.direction).toBe('received')
    expect(recv.counterparty).toBe('02sender2')
    expect(recv.assetId).toBe('x.0')
  })

  it('skips outputs with no assetId', () => {
    const noAsset = [
      {
        txid: 'bad',
        description: 'No asset',
        satoshis: 0,
        status: 'completed',
        isOutgoing: false,
        version: 1,
        lockTime: 0,
        labels: ['mandala', 'transfer'],
        outputs: [
          {
            outputIndex: 0,
            outputDescription: 'no asset output',
            basket: 'mandala',
            satoshis: 1,
            spendable: true,
            tags: ['mandala'],
            customInstructions: JSON.stringify({ keyID: 'k' })
          }
        ]
      }
    ]
    const rows = parseActionsToHistory(noAsset as any)
    expect(rows.find(r => r.txid === 'bad')).toBeUndefined()
  })

  it('returns correct kind label from labels', () => {
    const rows = parseActionsToHistory(actions as any)
    expect(rows.find(r => r.txid === 't1')!.kind).toBe('transfer')
    expect(rows.find(r => r.txid === 't3')!.kind).toBe('issue')
    expect(rows.find(r => r.txid === 't4')!.kind).toBe('redeem')
  })
})


describe('multi-output change (split change strategy)', () => {
  const changeOut = (index: number, amount: number): any => ({
    outputIndex: index,
    outputDescription: 'FT change',
    basket: 'mandala',
    satoshis: 1,
    spendable: true,
    lockingScript: ftScript(ASSET, amount),
    customInstructions: JSON.stringify({
      keyID: `change-1-${index}`,
      counterparty: '02self',
      direction: 'change',
      recipient: '02recip',
      sentAmount: 25
    })
  })

  it('reports the recipient amount once, ignoring N change outputs', () => {
    const rows = parseActionsToHistory([
      {
        txid: 'multi1',
        description: 'Send 25 of x.0',
        isOutgoing: true,
        labels: ['mandala', 'transfer'],
        outputs: [
          {
            outputIndex: 2,
            outputDescription: 'FT to recipient',
            satoshis: 1,
            spendable: false,
            lockingScript: ftScript(ASSET, 25),
            customInstructions: JSON.stringify({
              keyID: 'xfer-1', counterparty: '02recip', direction: 'sent', recipient: '02recip'
            })
          },
          changeOut(0, 40),
          changeOut(1, 10),
          changeOut(3, 5)
        ]
      }
    ] as any)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.direction).toBe('sent')
    expect(row.amount).toBe(25)
    expect(row.counterparty).toBe('02recip')
  })

  it('falls back to sentAmount when only change outputs remain (recipient output dropped)', () => {
    // The recipient output is not basket-tracked and drops out of listActions;
    // the change outputs decode as FTs but must NOT be mistaken for the send.
    const rows = parseActionsToHistory([
      {
        txid: 'multi2',
        description: 'Send 25 of x.0',
        isOutgoing: true,
        labels: ['mandala', 'transfer'],
        outputs: [changeOut(1, 40), changeOut(2, 10)]
      }
    ] as any)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.direction).toBe('sent')
    expect(row.amount).toBe(25) // sentAmount, not the 40-unit change output
    expect(row.counterparty).toBe('02recip')
  })

  it('never mistakes a SPENT change output (CI erased) for the recipient', () => {
    // Spending a change output erases its customInstructions; only its
    // outputDescription survives. The 40-unit spent change must not be
    // reported as the sent amount — the intact change CI carries sentAmount.
    const spentChange = {
      outputIndex: 0,
      outputDescription: 'FT change',
      satoshis: 1,
      spendable: false,
      lockingScript: ftScript(ASSET, 40)
      // no customInstructions — erased on spend
    }
    const rows = parseActionsToHistory([
      {
        txid: 'multi4',
        description: 'Send 25 of x.0',
        isOutgoing: true,
        labels: ['mandala', 'transfer'],
        outputs: [spentChange, changeOut(1, 10)]
      }
    ] as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(25) // sentAmount, not the spent 40-unit change
  })

  it('falls back to sentAmount when change outputs carry CI but no locking scripts', () => {
    const bare = (index: number): any => ({
      outputIndex: index,
      outputDescription: 'FT change',
      satoshis: 1,
      spendable: true,
      tags: ['mandala', 'x.0'],
      customInstructions: JSON.stringify({
        keyID: `change-1-${index}`, counterparty: '02self', direction: 'change', recipient: '02recip', sentAmount: 25
      })
    })
    const rows = parseActionsToHistory([
      {
        txid: 'multi3',
        description: 'Send 25 of x.0',
        isOutgoing: true,
        labels: ['mandala', 'transfer'],
        outputs: [bare(1), bare(2)]
      }
    ] as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(25)
    expect(rows[0].counterparty).toBe('02recip')
  })
})

describe('counterparty from persistent action labels', () => {
  const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

  it('sent: reads the to-<key> label when outputs carry no customInstructions (spent/relinquished)', () => {
    const rows = parseActionsToHistory([
      {
        txid: 'old-send',
        description: 'Send 22 of x.0',
        isOutgoing: true,
        labels: ['mandala', 'transfer', `to-${KEY}`],
        outputs: [
          { outputIndex: 0, outputDescription: 'FT to recipient', tags: ['mandala', 'sent', 'x.0'] }
        ]
      }
    ] as any)
    const row = rows.find(r => r.txid === 'old-send')!
    expect(row.direction).toBe('sent')
    expect(row.counterparty).toBe(KEY)
  })

  it('received: reads the from-<key> label when customInstructions are gone', () => {
    const rows = parseActionsToHistory([
      {
        txid: 'old-recv',
        description: 'Receive 40 of x.0',
        isOutgoing: false,
        labels: ['mandala', 'receive', `from-${KEY}`],
        outputs: [
          { outputIndex: 0, outputDescription: 'received FT', tags: ['mandala', 'received', 'x.0'] }
        ]
      }
    ] as any)
    const row = rows.find(r => r.txid === 'old-recv')!
    expect(row.direction).toBe('received')
    expect(row.counterparty).toBe(KEY)
  })

  it('kind classification ignores the counterparty labels regardless of order', () => {
    const rows = parseActionsToHistory([
      {
        txid: 'ordered',
        isOutgoing: true,
        labels: ['mandala', `to-${KEY}`, 'transfer'],
        outputs: [{ outputIndex: 0, tags: ['mandala', 'x.0'] }]
      }
    ] as any)
    expect(rows.find(r => r.txid === 'ordered')!.kind).toBe('transfer')
  })
})

describe('exportTransactionsCsv', () => {
  it('CSV has a header and one row per history entry', () => {
    const rows = parseActionsToHistory(actions as any)
    const csv = exportTransactionsCsv(rows)
    const lines = csv.split('\n')
    expect(lines).toHaveLength(rows.length + 1) // header + N data rows
    expect(lines[0]).toContain('txid')
    expect(lines[0]).toContain('direction')
    expect(lines[0]).toContain('counterparty')
  })

  it('CSV header + 2 rows for the basic fixture (2 actions)', () => {
    const twoActions = actions.slice(0, 2)
    const csv = exportTransactionsCsv(parseActionsToHistory(twoActions as any))
    expect(csv.split('\n')).toHaveLength(3) // header + 2
  })

  it('escapes double quotes in CSV fields', () => {
    const rows = [
      {
        txid: 'tx-"quoted"',
        assetId: 'a.0',
        direction: 'sent' as const,
        amount: 0,
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
