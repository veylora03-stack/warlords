import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaWrite: PrismaClient | undefined
}

/**
 * READ client — every plain query goes through here. It carries the query
 * logger and the (tunable) connection pool for the read-heavy Mini App
 * traffic (WAL mode: readers never block the single writer).
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
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
