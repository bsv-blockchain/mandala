import { MongoClient, type Db } from 'mongodb'

export const TEST_MONGO_URL = process.env.MANDALA_TEST_MONGO_URL ?? 'mongodb://localhost:27017'

export interface TestMongo { db: Db, close: () => Promise<void> }

/**
 * A throwaway database on the local Mongo, or null when none is reachable —
 * the same skip pattern overlay-go's Mongo-backed tests use. Each call gets its
 * own database, dropped by `close()`.
 */
export const connectTestMongo = async (label: string): Promise<TestMongo | null> => {
  const client = new MongoClient(TEST_MONGO_URL, { serverSelectionTimeoutMS: 1500 })
  try {
    await client.connect()
    await client.db('admin').command({ ping: 1 })
  } catch {
    await client.close().catch(() => {})
    return null
  }
  const db = client.db(`mandala_test_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
  return {
    db,
    close: async () => {
      await db.dropDatabase().catch(() => {})
      await client.close()
    }
  }
}

/** Resolved once per test file: whether a local Mongo is reachable at all. */
export const mongoAvailable = async (): Promise<boolean> => {
  const probe = await connectTestMongo('probe')
  if (probe == null) return false
  await probe.close()
  return true
}
