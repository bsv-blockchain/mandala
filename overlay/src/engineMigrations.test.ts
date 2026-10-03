import { describe, it, expect } from 'vitest'
import knexFactory from 'knex'
import { KnexStorageMigrations } from '@bsv/overlay'
import { runEngineMigrations } from './engineMigrations.js'

const migrations: any[] = (KnexStorageMigrations as any).default ?? KnexStorageMigrations

// The source overlay-express 2.7.3 hands to knex.migrate.latest inside start().
const overlayExpressSource = (ms: any[]): any => ({
  getMigrations: async () => ms,
  getMigrationName: (m: any) => (typeof m.name === 'string' ? m.name : `Migration at index ${ms.indexOf(m)}`),
  getMigration: async (m: any) => m
})

const mem = () => knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })

describe('runEngineMigrations', () => {
  it('creates the engine tables', async () => {
    const knex = mem()
    try {
      await runEngineMigrations(knex, migrations)
      expect(await knex.schema.hasTable('outputs')).toBe(true)
    } finally { await knex.destroy() }
  })

  it("leaves overlay-express's own start() migrate.latest a no-op", async () => {
    const knex = mem()
    try {
      await runEngineMigrations(knex, migrations)
      const result = await knex.migrate.latest({ migrationSource: overlayExpressSource(migrations) })
      expect(result[1]).toEqual([])
    } finally { await knex.destroy() }
  })

  it('is idempotent', async () => {
    const knex = mem()
    try {
      await runEngineMigrations(knex, migrations)
      await runEngineMigrations(knex, migrations)
      expect(await knex.schema.hasTable('outputs')).toBe(true)
    } finally { await knex.destroy() }
  })
})
