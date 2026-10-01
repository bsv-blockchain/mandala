import type { Transaction } from '@bsv/sdk'

/** Exact description overlay-express 2.7.3 ArcadeProvider.broadcast returns for a non-terminal 2xx outside its success set. */
export const UNKNOWN_SUCCESS_STATUS = 'Arcade returned an unknown success status'

export const withArcadeStatusParity = <B extends { broadcast: (tx: Transaction) => Promise<any> }>(inner: B): B => {
  const original = inner.broadcast.bind(inner)
  inner.broadcast = async (tx: Transaction) => {
    const r = await original(tx)
    if (r?.status === 'error' && r.code === '500' && r.description === UNKNOWN_SUCCESS_STATUS && r.more?.terminal === false) {
      return { status: 'success', txid: tx.id('hex'), message: 'non-terminal Arcade status accepted (Go parity)' }
    }
    return r
  }
  return inner
}
