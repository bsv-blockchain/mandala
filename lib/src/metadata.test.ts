/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { LockingScript, Transaction } from '@bsv/sdk'
import fRaw from './__fixtures__/1color-deploy.json?raw'
import { parseMetadataFromBeef } from './metadata.js'

const F = JSON.parse(fRaw) as { lockingScriptHex: string }

describe('parseMetadataFromBeef', () => {
  it('reads the F-REQ deploy payload', () => {
    const tx = new Transaction(1, [], [{ lockingScript: LockingScript.fromHex(F.lockingScriptHex), satoshis: 1 }])
    expect(parseMetadataFromBeef(tx.toBEEF(), 0)).toEqual({ label: 'Test Dollar', ticker: 'TUSD', decimals: 2 })
  })

  it('is null for a missing output or garbage bytes', () => {
    const tx = new Transaction(1, [], [{ lockingScript: LockingScript.fromHex(F.lockingScriptHex), satoshis: 1 }])
    expect(parseMetadataFromBeef(tx.toBEEF(), 1)).toBeNull()
    expect(parseMetadataFromBeef([1, 2, 3], 0)).toBeNull()
  })
})
