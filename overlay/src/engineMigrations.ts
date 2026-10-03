/**
 * Run the engine's knex migrations ourselves, before the boot owner-index run.
 *
 * overlay-express 2.7.3 only migrates inside `server.start()`, but the boot
 * reconcile reads the engine's `outputs` table first, so on a fresh database
 * (or after a new engine migration) it fails. This source names migrations
 * exactly as overlay-express's InMemoryMigrationSource does, so the later
 * `migrate.latest` in start() finds them all applied and is a no-op.
 */
import type { Knex } from 'knex'

type Migration = { name?: unknown }

export const runEngineMigrations = async (knex: Knex, migrations: Migration[]): Promise<void> => {
  const result = await knex.migrate.latest({
    migrationSource: {
      getMigrations: async () => migrations,
      getMigrationName: (m: Migration) =>
        typeof m.name === 'string' ? m.name : `Migration at index ${migrations.indexOf(m)}`,
      getMigration: async (m: Migration) => m
    } as any
  })
  console.log(`[mandala] engine migrations: ${result[1].length} applied`)
}
