import {
  Transaction, TransactionSignature, Signature, UnlockingScript,
  ScriptTemplateUnlock, WalletInterface, WalletCounterparty, Hash, Utils
} from '@bsv/sdk'
import { ADMIN_PROTOCOL } from '../constants.js'

type SignOutputs = 'all' | 'none' | 'single'

// Replicated from @bsv/templates mandala-signing.ts so we can sign via a wallet.
function buildSighashPreimage (
  tx: Transaction, inputIndex: number, signOutputs: SignOutputs, anyoneCanPay: boolean
): { preimage: number[], scope: number } {
  let scope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') scope |= TransactionSignature.SIGHASH_ALL
  else if (signOutputs === 'none') scope |= TransactionSignature.SIGHASH_NONE
  else if (signOutputs === 'single') scope |= TransactionSignature.SIGHASH_SINGLE
  if (anyoneCanPay) scope |= TransactionSignature.SIGHASH_ANYONECANPAY

  const input = tx.inputs[inputIndex]
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (sourceTXID == null) throw new Error('sourceTXID or sourceTransaction required')
  if (sourceOutput?.satoshis == null) throw new Error('source satoshis required')
  if (sourceOutput.lockingScript == null) throw new Error('source lockingScript required')

  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: sourceOutput.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: sourceOutput.lockingScript,
    lockTime: tx.lockTime,
    scope
  })
  return { preimage, scope }
}

/**
 * Unlocking template for a Mandala-key 1Color output (treasury, authority,
 * deploy, registry, payout change): a wallet signature under ADMIN_PROTOCOL
 * `[2, 'mandala admin']`, `keyID`, `counterparty`. The DER signature is used
 * as the wallet returns it: S is never normalized (BSV Chronicle).
 */
export function issuerUnlock (
  wallet: WalletInterface,
  keyID: string,
  counterparty: WalletCounterparty,
  signOutputs: SignOutputs = 'all',
  anyoneCanPay = false
): ScriptTemplateUnlock {
  return {
    sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
      const { preimage, scope } = buildSighashPreimage(tx, inputIndex, signOutputs, anyoneCanPay)
      const { signature: der } = await wallet.createSignature({
        hashToDirectlySign: Hash.hash256(preimage),
        protocolID: ADMIN_PROTOCOL, keyID, counterparty
      })
      const sig = Signature.fromDER([...der])
      const txSig = new TransactionSignature(sig.r, sig.s, scope)
      const sigForScript = txSig.toChecksigFormat()
      // The signature is made with derivePrivateKey(counterparty); its matching public
      // key is the forSelf:true derivation (= the key the locker hashed, by BRC-42
      // symmetry). For self-held tokens forSelf is symmetric; for tokens locked TO us
      // by another party (counterparty = sender) only forSelf:true matches the pkh.
      const { publicKey } = await wallet.getPublicKey({ protocolID: ADMIN_PROTOCOL, keyID, counterparty, forSelf: true })
      const pubkey = Utils.toArray(publicKey, 'hex')
      return new UnlockingScript([
        { op: sigForScript.length, data: sigForScript },
        { op: pubkey.length, data: pubkey }
      ])
    },
    estimateLength: async () => 108
  }
}
