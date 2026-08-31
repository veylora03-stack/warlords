import { PrismaClient } from '@prisma/client'
import { getEnvSafe } from '@/config/env'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaWrite: PrismaClient | undefined
}

/**
 * Production-safe logging gate (Phase 26): the per-query log fires on EVERY
 * read in dev (invaluable for N+1 hunts) but must be silent in production —
 * it would flood stdout/JSON log streams, leak query shapes/params, and
 * cost measurable CPU at load. Production keeps only error + warn events.
 */
const prismaReadLogLevel = getEnvSafe()?.isProd
  ? (['error', 'warn'] as const)
  : (['query'] as const)

/**
 * READ client — every plain query goes through here. It carries the query
 * logger and the (tunable) connection pool for the read-heavy Mini App
 * traffic (WAL mode: readers never block the single writer).
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [...prismaReadLogLevel],
  })

/**
 * TRANSACTION client (Phase 25) — every interactive transaction runs on
 * THIS client. Rationale (measured, scripts/bench/): the Prisma engine
 * processes queries through a bounded pipeline; under heavy read load a
 * transaction's BEGIN could sit >5 s behind the read queue and die as a
 * P1008 socket timeout (×6 retries = 30 s stalls). Giving transactions
 * their own engine instance isolates the write path from read saturation —
 * raw multi-process SQLite proves the file itself handles concurrent
 * writers in ≤0.1 ms, so the engine queue was the only bottleneck.
 *
 * SQLite has exactly one writer anyway (further serialized in-process by
 * the economy service's db:write mutex); on PostgreSQL this client remains
 * correct as-is (CAS/row-locks stay the multi-instance backstop).
 */
export const dbWrite =
  globalForPrisma.prismaWrite ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
  globalForPrisma.prismaWrite = dbWrite
}
