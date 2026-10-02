/**
 * The production `AdmissionStore` over the Mongo `mandalaAdmissions`
 * collection (wire contract §4, §9.1, §9.4).
 */
import type { Collection, Document } from 'mongodb'
import type { AdmissionRecord, AdmissionStore } from './admission.js'
import { mergeRestore, type AdmissionRestore } from './submitSideChannel.js'

export const mongoAdmissionStore = (admissionsCol: Collection<Document>): AdmissionStore => {
  /**
   * The restore snapshot to write: the stored one merged with `incoming`
   * (`mergeRestore` — it only ever grows), or nothing to write at all when
   * there is no incoming snapshot.
   *
   * A read-then-write is sound here: every write of a txid's snapshot runs
   * inside the engine's per-process submission lock (`putPending`, from the
   * topic manager) or right after it for the same attempt (`putAdmitted`), and
   * a concurrent same-txid submit meets the engine's dupe check before its
   * manager runs. A lost update could only drop an outpoint that a concurrent writer
   * added and this one lacked; every writer's outpoints were already written by its
   * own `putPending` first, so none can be.
   */
  const restoreToWrite = async (txid: string, incoming?: AdmissionRestore): Promise<AdmissionRestore | undefined> => {
    if (incoming == null) return undefined
    const prior = await admissionsCol.findOne({ txid }, { projection: { _id: 0, restore: 1 } }) as { restore?: AdmissionRestore } | null
    return mergeRestore(prior?.restore, incoming)
  }

  return {
    get: async (txid) =>
      await admissionsCol.findOne({ txid }, { projection: { _id: 0 } }) as AdmissionRecord | null,
    // §9.4 — the provisional record, written by the topic-manager wrapper
    // before the engine can broadcast. `pending` is set ONLY on insert, so a
    // re-submit of an already-finalized txid never downgrades its record.
    putPending: async (rec) => {
      const restore = await restoreToWrite(rec.txid, rec.restore)
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            topics: rec.topics,
            ...(restore != null ? { restore } : {})
          },
          $setOnInsert: { txid: rec.txid, at: rec.at, pending: true }
        },
        { upsert: true }
      )
    },
    putAdmitted: async (rec) => {
      // The pre-spend snapshot FIX E reads back at eviction time, merged into
      // the provisional one. Absent only when the topic-manager wrapper could
      // not take it; the eviction still runs, it just restores what it has.
      const restore = await restoreToWrite(rec.txid, rec.restore)
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            topics: rec.topics,
            outputsToAdmit: rec.outputsToAdmit,
            admissionSignature: rec.admissionSignature,
            admissionIdentityKey: rec.admissionIdentityKey,
            pending: false,
            ...(restore != null ? { restore } : {})
          },
          // §9.1 — an admission CLEARS the refusal fields. A transaction whose
          // earlier payload was refused and whose corrected payload is admitted
          // must stop carrying that refusal, or GET /admin/admission/:txid would
          // keep serving a 400 for a transaction this overlay has just signed.
          $unset: {
            refusedCode: '', refusedDescription: '', refusedAt: '',
            refusedPayloadHash: '', refusedSpendTxid: ''
          },
          $setOnInsert: { txid: rec.txid, at: rec.at }
        },
        { upsert: true }
      )
    },
    putRefusal: async (rec) => {
      // §9.1 — keyed by (txid, payloadHash). A later submission with a DIFFERENT
      // payload overwrites these fields with its own verdict; one with the same
      // payload is short-circuited before it ever reaches here.
      await admissionsCol.updateOne(
        { txid: rec.txid },
        {
          $set: {
            refusedCode: rec.refusedCode,
            refusedDescription: rec.refusedDescription,
            refusedAt: rec.refusedAt,
            refusedPayloadHash: rec.refusedPayloadHash
          },
          $setOnInsert: { txid: rec.txid, at: rec.refusedAt }
        },
        { upsert: true }
      )
    },
    markEvicted: async (txid, at) => {
      await admissionsCol.updateOne(
        { txid },
        { $set: { evictedAt: at }, $setOnInsert: { txid, at } },
        { upsert: true }
      )
    }
  }
}
