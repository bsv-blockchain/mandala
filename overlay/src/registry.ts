/**
 * Issuer-level identity registration chain. Separate topic from tm_mandala.
 * Mongo `mandalaRegistry` is a cache of the chain replay.
 */
import { LookupService, TopicManager } from '@bsv/overlay'
import { Transaction, WalletInterface, WalletProtocol, Hash, Utils } from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'

export type RegistryKind = 'register' | 'admitIdentity' | 'revokeIdentity'
export interface RegistryActionDetails {
  kind: RegistryKind
  identityKey?: string
  issuer?: string
  priorOutpoint?: string
  counterparty?: string
  [k: string]: unknown
}
import { Db, Collection } from 'mongodb'

export const REGISTRY_TOPIC = 'tm_mandala_registry'
export const REGISTRY_LOOKUP = 'ls_mandala_registry'
export const REGISTRY_PROTOCOL: WalletProtocol = [2, 'mandala registry']

export interface RegistryRow {
  identityKey: string
  status: 'admitted' | 'revoked'
  txid: string
  outputIndex: number
  admitSeq: number
  createdAt: Date
  actionDetails?: RegistryActionDetails
}

export class RegistryStore {
  private readonly col: Collection<RegistryRow>
  private readonly counters: Collection<{ _id: string, seq: number }>
  constructor (db: Db) {
    this.col = db.collection('mandalaRegistry')
    this.counters = db.collection<{ _id: string, seq: number }>('mandalaCounters')
  }

  async ensureIndexes (): Promise<void> {
    await this.col.createIndex({ identityKey: 1 }, { unique: true })
    await this.col.createIndex({ status: 1 })
    await this.seedSeq()
  }

  /**
   * Seed the persisted counter from the highest sequence already on disk, so
   * the first action after this upgrade sorts ABOVE the existing rows rather
   * than restarting at 1 and making an older row look like the chain head.
   * Runs once: `$setOnInsert` leaves an existing counter alone.
   */
  private async seedSeq (): Promise<void> {
    const highest = await this.col.find({}, { projection: { admitSeq: 1 } })
      .sort({ admitSeq: -1 }).limit(1).next()
    await this.counters.updateOne(
      { _id: 'registryAdmitSeq' },
      { $setOnInsert: { seq: highest?.admitSeq ?? 0 } },
      { upsert: true }
    )
  }

  async isAdmitted (identityKey: string): Promise<boolean> {
    const row = await this.col.findOne({ identityKey })
    return row?.status === 'admitted'
  }

  async isActive (): Promise<boolean> {
    return (await this.col.countDocuments()) > 0
  }

  async upsert (row: RegistryRow): Promise<void> {
    await this.col.updateOne({ identityKey: row.identityKey }, { $set: row }, { upsert: true })
  }

  async list (): Promise<RegistryRow[]> {
    return await this.col.find({}, { projection: { _id: 0 } }).sort({ admitSeq: -1 }).toArray()
  }

  /**
   * Monotonic admit sequence, persisted in Mongo.
   *
   * This orders the chain: `list()` is sorted by it and the client picks the
   * newest row as the live head. An in-process counter resets to zero on every
   * restart, so rows written after a reboot would sort BELOW older ones and the
   * client would try to spend an outpoint that is already spent.
   */
  async nextSeq (): Promise<number> {
    const doc = await this.counters.findOneAndUpdate(
      { _id: 'registryAdmitSeq' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    )
    return doc?.seq ?? 1
  }
}

export function foldRegistry (details: RegistryActionDetails, txid: string, vout: number, seq: number): RegistryRow | null {
  let key = typeof details.identityKey === 'string' ? details.identityKey : ''
  if (key === '' && details.kind === 'register' && typeof details.issuer === 'string') {
    key = details.issuer
  }
  if (key === '') return null
  let status: RegistryRow['status']
  switch (details.kind) {
    case 'revokeIdentity': status = 'revoked'; break
    case 'admitIdentity':
    case 'register': status = 'admitted'; break
    default: return null
  }
  return { identityKey: key, status, txid, outputIndex: vout, admitSeq: seq, createdAt: new Date(), actionDetails: details }
}

function priorSpent (tx: Transaction, details: RegistryActionDetails): boolean {
  if (details.kind === 'register') return true
  if (typeof details.priorOutpoint !== 'string') return false
  return tx.inputs.some(
    inp => `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}` === details.priorOutpoint
  )
}

/** Whether the registration chain already exists. Only genesis needs it. */
export interface RegistryChainStore {
  isActive: () => Promise<boolean>
}

export class RegistryTopicManager implements TopicManager {
  constructor (
    private readonly wallet: WalletInterface,
    private readonly store?: RegistryChainStore,
    private readonly protocolID: WalletProtocol = REGISTRY_PROTOCOL
  ) {}

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[]
  ): Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }> {
    const tx = Transaction.fromBEEF(beef)
    let payload: { admin?: Array<{ index: number, actionDetails: RegistryActionDetails }> } = {}
    if (offChainValues != null && offChainValues.length > 0) {
      payload = JSON.parse(Utils.toUTF8(offChainValues))
    }
    const byIndex = new Map((payload.admin ?? []).map(a => [a.index, a.actionDetails]))
    const admittedInputs = new Set(
      previousCoins
        .filter(ci => ci < tx.inputs.length)
        .map(ci => {
          const inp = tx.inputs[ci]
          return `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}`
        })
    )
    const admit: number[] = []
    for (let i = 0; i < tx.outputs.length; i++) {
      const details = byIndex.get(i)
      if (details == null) continue
      if (details.kind !== 'register' && details.kind !== 'admitIdentity' && details.kind !== 'revokeIdentity') continue
      let decoded: ReturnType<typeof MandalaAdmin.decode>
      try {
        decoded = MandalaAdmin.decode(tx.outputs[i].lockingScript)
      } catch { continue }
      const keyID = MandalaAdmin.commitment(details as any)
      const counterparty = typeof details.counterparty === 'string' ? details.counterparty : 'self'
      const { publicKey } = await this.wallet.getPublicKey({
        protocolID: this.protocolID,
        keyID,
        counterparty,
        forSelf: false
      })
      const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
      if (pkh.length !== decoded.pubKeyHash.length || pkh.some((b, j) => b !== decoded.pubKeyHash[j])) continue
      if (details.kind === 'register') {
        // Genesis only. A second register folds another 'admitted' row into the
        // same issuer-level collection, which is a KYC bypass rather than a new
        // chain.
        if (this.store != null && await this.store.isActive()) {
          throw new Error('tm_mandala_registry: registration chain already exists; register is genesis-only')
        }
      } else {
        // Authority on this chain is the spend, not the key: details.counterparty
        // is attacker-supplied and BRC-42 derivation hands that counterparty a
        // key it can spend. Every output this topic admits is a registration
        // chain output, so an input listed in previousCoins IS the prior link.
        const prior = typeof details.priorOutpoint === 'string' ? details.priorOutpoint : ''
        if (prior === '' || !admittedInputs.has(prior)) continue
      }
      if (tx.outputs[i].satoshis !== 1) {
        throw new Error(`tm_mandala_registry: output ${i} must carry exactly 1 satoshi`)
      }
      admit.push(i)
    }
    if (admit.length === 0) throw new Error('tm_mandala_registry: no admissible registry outputs')
    return { outputsToAdmit: admit, coinsToRetain: previousCoins }
  }

  async getDocumentation (): Promise<string> {
    return 'Issuer-level identity registration chain (admit / revoke). Database is a cache of the chain.'
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return { name: REGISTRY_TOPIC, shortDescription: 'Identity registration chain' }
  }
}

export function createRegistryLookup (store: RegistryStore): LookupService {
  return {
    admissionMode: 'whole-tx',
    spendNotificationMode: 'script',
    async outputAdmittedByTopic (p) {
      if (p.topic !== REGISTRY_TOPIC || p.mode !== 'whole-tx') return
      const tx = Transaction.fromBEEF(p.atomicBEEF)
      let payload: { admin?: Array<{ index: number, actionDetails: RegistryActionDetails }> } = {}
      if (p.offChainValues != null && p.offChainValues.length > 0) {
        payload = JSON.parse(Utils.toUTF8(p.offChainValues))
      }
      const entry = (payload.admin ?? []).find(a => a.index === p.outputIndex)
      if (entry == null) return
      const row = foldRegistry(entry.actionDetails, tx.id('hex'), p.outputIndex, await store.nextSeq())
      if (row != null) await store.upsert(row)
    },
    async outputSpent () {},
    async outputEvicted (_txid: string, _outputIndex: number) {},
    async lookup () {
      return []
    },
    async getDocumentation () {
      return 'ls_mandala_registry folds admit/revoke into mandalaRegistry.'
    },
    async getMetaData () {
      return { name: REGISTRY_LOOKUP, shortDescription: 'Identity registration cache' }
    }
  }
}

/** The slice of RegistryStore the membership gate reads. */
export interface RegistryMembership {
  isActive: () => Promise<boolean>
  isAdmitted: (identityKey: string) => Promise<boolean>
}

/** Where the gate learns which identities are asset issuers. */
export interface IssuerKeySource {
  /** Every `issuerIdentityKey` the asset-state store currently holds. Read live per check. */
  issuerIdentityKeys: () => Promise<string[]>
}

export interface MembershipExemptions {
  issuers?: IssuerKeySource
  /** Keys that are never subject to membership — the overlay's own identity. */
  identityKeys?: string[]
}

/**
 * Membership gate (A04), exposed through the upstream manager's
 * ScreeningProvider seam: once the registry has any row, an identity that is
 * not admitted is refused.
 *
 * Asset issuers are exempt, exactly as in the Go overlay's membershipHolds
 * (`overlay-go/internal/mandala/topic_manager.go`): the exemption covers every
 * issuer the state store knows plus the overlay identity. Without it, a
 * revoked issuer row or a lost `mandalaRegistry` index would lock the issuer
 * out of every admin action — including `unpause` — with no way back.
 *
 * `extraBanned` is the sanctions list proper and wins over the exemption.
 */
export function registryScreening (
  store: RegistryMembership,
  extraBanned: string[] = [],
  exempt: MembershipExemptions = {}
): { isSanctioned: (identityKey: string) => Promise<boolean> } {
  const banned = new Set(extraBanned)
  const always = new Set(exempt.identityKeys ?? [])
  return {
    async isSanctioned (identityKey: string): Promise<boolean> {
      if (banned.has(identityKey)) return true
      if (always.has(identityKey)) return false
      if (!await store.isActive()) return false
      if (exempt.issuers != null && (await exempt.issuers.issuerIdentityKeys()).includes(identityKey)) return false
      return !(await store.isAdmitted(identityKey))
    }
  }
}
