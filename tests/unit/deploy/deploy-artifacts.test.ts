/**
 * Unit tests — deployment artifacts integrity (Phase 26).
 *
 * Guards the production split against silent rot:
 *  1. `.env.example` documents EVERY key of the validated env schema
 *     (the template cannot drift behind src/config/env.ts).
 *  2. `prisma/postgres/schema.prisma` is model-identical to
 *     `prisma/schema.prisma` except for the datasource provider.
 *  3. The committed PostgreSQL baseline migration covers every mapped
 *     table and carries the indexed columns the schema declares
 *     (regression for the players_honor_idx display-ghost incident).
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../../../src/config/env'

const ROOT = process.cwd()

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Strips comments/blank lines and normalizes the datasource provider. */
function normalizeSchema(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd())
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('//'))
    .join('\n')
    .replace(/provider\s*=\s*"(sqlite|postgresql)"/, 'provider = "PROVIDER"')
}

describe('.env.example documents the full environment contract', () => {
  it('contains every key of the validated env schema (plus ops-only keys)', () => {
    const env = loadEnv({ DATABASE_URL: 'file:./db/custom.db' })
    const template = readRepo('.env.example')
    const appKeys = Object.keys(env).filter(
      (k) =>
        k !== 'isDev' &&
        k !== 'isProd' &&
        k !== 'isTest' &&
        // derived ops flag — the RAW key NOTIFICATION_WORKER_DISABLED is
        // what .env.example documents
        k !== 'notificationWorkerDisabled',
    )
    expect(appKeys.length).toBeGreaterThanOrEqual(8)
    for (const key of appKeys) {
      expect(template).toContain(key)
    }
    // ops keys consumed by the container entrypoint / platform
    expect(template).toContain('RUN_MIGRATIONS')
  })

  it('never ships a non-empty secret value in the template', () => {
    for (const line of readRepo('.env.example').split('\n')) {
      const m = /^([A-Z_]+)=(.+)$/.exec(line.trim())
      if (!m) continue
      const key = m[1]!
      const value = m[2]!
      if (/TOKEN|SECRET|PASSWORD/.test(key)) {
        // inline comment after `=` is fine; a real value is not
        expect(value.trim().startsWith('#')).toBe(true)
      }
    }
  })
})

describe('prisma/postgres is the faithful production twin of the dev schema', () => {
  it('is model-identical to prisma/schema.prisma except the provider', () => {
    const dev = normalizeSchema(readRepo('prisma/schema.prisma'))
    const prod = normalizeSchema(readRepo('prisma/postgres/schema.prisma'))
    expect(prod).toBe(dev)
  })

  it('declares the postgresql provider and a committed migration lock', () => {
    expect(readRepo('prisma/postgres/schema.prisma')).toContain('provider = "postgresql"')
    expect(readRepo('prisma/postgres/migrations/migration_lock.toml')).toContain(
      'provider = "postgresql"',
    )
  })
})

describe('the committed PostgreSQL migrations cover the whole schema', () => {
  // Deploy semantics: the baseline PLUS every committed incremental migration
  // (applied in filename order) must reproduce the schema contract. Phase 32
  // added world_regions/territory_history through an incremental migration,
  // exactly as the migration system intends.
  const MIGRATIONS_DIR = 'prisma/postgres/migrations'
  const baseline = readRepo(`${MIGRATIONS_DIR}/00000000000000_init/migration.sql`)
  const incremental = readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((entry) => /^\d{14}_/.test(entry) && entry !== '00000000000000_init')
    .sort()
    .map((entry) => readRepo(`${MIGRATIONS_DIR}/${entry}/migration.sql`))
    .join('\n')
  const applied = `${baseline}\n${incremental}`
  const schema = readRepo('prisma/postgres/schema.prisma')

  it('creates every @@map table the schema declares (baseline + committed migrations)', () => {
    const mapped = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]!)
    expect(mapped.length).toBeGreaterThan(30)
    for (const table of mapped) {
      expect(applied).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('creates the Phase 32 world tables through the committed incremental migration', () => {
    expect(incremental).toContain('CREATE TABLE "world_regions"')
    expect(incremental).toContain('CREATE TABLE "territory_history"')
  })

  it('carries the players honor index (regression: display-ghost @@index corruption)', () => {
    expect(schema).toContain('@@index([honor])')
    expect(baseline).toContain('CREATE INDEX "players_honor_idx" ON "players"("honor");')
  })

  it('is additive-only DDL (no destructive statements in the baseline)', () => {
    expect(baseline).not.toMatch(/\bDROP TABLE\b/i)
    expect(baseline).not.toMatch(/\bTRUNCATE\b/i)
    expect(baseline).not.toMatch(/\bDELETE FROM\b/i)
  })
})
