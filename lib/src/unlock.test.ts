import { describe, it, expect } from 'vitest'
import {
  ProtoWallet, PrivateKey, Transaction, Spend
} from '@bsv/sdk'
import { MandalaToken } from './__fixtures__/token.js'
import { walletMandalaUnlock } from './unlock.js'
import { FT_PROTOCOL } from './constants.js'

describe('walletMandalaUnlock', () => {
  it('produces an unlocking script that satisfies a MandalaToken output locked to a wallet-derived key', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const keyID = 'tkn-1'
    const counterparty = 'self'
    const assetId = `${'a'.repeat(64)}_0`

    const lockingScript = await new MandalaToken(wallet as any).lockBRC29(assetId, 100, FT_PROTOCOL, keyID, counterparty)

    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript, satoshis: 1 })

    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript, satoshis: 1 })

    const unlocker = walletMandalaUnlock(wallet as any, keyID, counterparty)
    spendTx.inputs[0].unlockingScript = await unlocker.sign(spendTx, 0)

    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript,
      transactionVersion: spendTx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: spendTx.inputs[0].unlockingScript!,
      outputs: spendTx.outputs,
      inputSequence: 0xffffffff,
      lockTime: spendTx.lockTime
    })
    expect(spend.validate()).toBe(true)
  })

  it('lets a recipient spend a token a different party locked TO them (cross-party forSelf)', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const recipient = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: senderId } = await sender.getPublicKey({ identityKey: true })
    const { publicKey: recipientId } = await recipient.getPublicKey({ identityKey: true })
    const keyID = 'xfer-1'
    const assetId = `${'b'.repeat(64)}_0`

    // Sender locks the FT to the recipient (counterparty = recipient identity).
    const lockingScript = await new MandalaToken(sender as any).lockBRC29(assetId, 100, FT_PROTOCOL, keyID, recipientId)

    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript, satoshis: 1 })
    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript, satoshis: 1 })

    // Recipient spends, deriving against the sender's identity (as stored in CI on accept).
    const unlocker = walletMandalaUnlock(recipient as any, keyID, senderId)
    spendTx.inputs[0].unlockingScript = await unlocker.sign(spendTx, 0)

    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript,
      transactionVersion: spendTx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: spendTx.inputs[0].unlockingScript!,
      outputs: spendTx.outputs,
      inputSequence: 0xffffffff,
      lockTime: spendTx.lockTime
    })
    expect(spend.validate()).toBe(true)
  })
})
