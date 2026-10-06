// Test-only stand-in for the removed @bsv/templates MandalaToken, over BRC-162 Bsv21Binary.
import type { LockingScript, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { codec, lockToken } from '../brc162.js'

export class MandalaToken {
  constructor (private readonly wallet?: WalletInterface) {}
  lock (tokenId: string, amount: number, pkh: number[]): LockingScript {
    return codec.lock(tokenId, BigInt(amount), pkh)
  }

  async lockBRC29 (tokenId: string, amount: number, protocolID: WalletProtocol, keyID: string, counterparty: string): Promise<LockingScript> {
    return await lockToken(this.wallet as WalletInterface, tokenId, amount, protocolID, keyID, counterparty)
  }
}
