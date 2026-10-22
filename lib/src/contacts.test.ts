// app/src/lib/mandala/contacts.test.ts
import { it, expect } from 'vitest'
import { deriveContacts } from './contacts.js'

const h = (counterparty: string, when: number) => ({ txid: 't', assetId: 'x.0', direction: 'sent' as const, amount: 1n, counterparty, when, kind: 'transfer' })

it('dedups by identity key, orders by recency then frequency, drops empties', () => {
  const rows = [h('02a', 100), h('02b', 50), h('02a', 200), h('', 999)]
  const contacts = deriveContacts(rows as any)
  expect(contacts.map(c => c.identityKey)).toEqual(['02a', '02b'])
  expect(contacts[0]).toEqual({ identityKey: '02a', lastSeen: 200, count: 2, order: 2 })
})

it('falls back to history position for recency when timestamps are absent (when=0)', () => {
  // Production data has when=0 for every row; loadHistory returns oldest-first,
  // so the most recently seen counterparty is the one appearing latest.
  const rows = [h('02old', 0), h('02mid', 0), h('02new', 0), h('02mid', 0)]
  const contacts = deriveContacts(rows as any)
  // 02mid last seen at index 3, 02new at 2, 02old at 0 → recency order:
  expect(contacts.map(c => c.identityKey)).toEqual(['02mid', '02new', '02old'])
})
