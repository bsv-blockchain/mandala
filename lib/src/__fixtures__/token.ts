// Test-only stand-in for the removed @bsv/templates MandalaToken, over BRC-162 1Color (OneColor).
import type { LockingScript, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'

export class MandalaToken {
  constructor (private readonly wallet?: WalletInterface) {}
  lock (tokenId: string, amount: bigint, pkh: number[]): LockingScript {
    return new OneColor().lock(tokenId, amount, pkh)
  }

  async lockBRC29 (tokenId: string, amount: bigint, protocolID: WalletProtocol, keyID: string, counterparty: string): Promise<LockingScript> {
    return await new OneColor(this.wallet).lockBRC29(tokenId, amount, protocolID, keyID, counterparty)
  }
}
