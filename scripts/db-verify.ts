/**
 * WARLORDS — Database invariant verifier.
 *
 * Run: `bun run db:verify` (part of the phase quality gate).
 *
 * Asserts the economy/world invariants against the REAL database:
 *   V1. Ledger reconciliation: Σ(delta) per resource == wallet balance
 *   V2. Every player has: wallet, city with all starter building types,
 *       ≥1 ledger row, and their starter quests
 *   V3. Referential integrity of data-driven config stored in DB:
 *       quest prerequisites and unit counter references resolve
 *   V4. Catalogs are seeded (non-empty)
 *   V5. Unique city coordinates (no overlapping keeps)
 *
 * Exits non-zero on any violation — CI/quality-gate friendly.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['error'] })

const WALLET_COLUMNS = {
  GOLD: 'gold',
  WOOD: 'wood',
  IRON: 'iron',
  FOOD: 'food',
  CRYSTAL: 'crystal',
} as const

interface Violation {
  check: string
  detail: string
}

async function main(): Promise<number> {
  const violations: Violation[] = []
  const push = (check: string, detail: string) => violations.push({ check, detail })

  // ── V4: catalogs seeded ──────────────────────────────────────────────────
  const [units, techs, quests, achievements, items, seasons] = await Promise.all([
    prisma.unit.count(),
    prisma.technology.count(),
    prisma.quest.count(),
    prisma.achievement.count(),
    prisma.item.count(),
    prisma.season.count(),
  ])
  if (units < 5) push('V4-catalogs', `units table has ${units} rows, expected ≥ 5`)
  if (techs < 4) push('V4-catalogs', `technologies table has ${techs} rows, expected ≥ 4`)
  if (quests < 5) push('V4-catalogs', `quests table has ${quests} rows, expected ≥ 5`)
  if (achievements < 4)
    push('V4-catalogs', `achievements table has ${achievements} rows, expected ≥ 4`)
  if (items < 4) push('V4-catalogs', `items table has ${items} rows, expected ≥ 4`)
  if (seasons < 1) push('V4-catalogs', 'no season row found')

  // ── V1 + V2: per-player economy invariants ───────────────────────────────
  const players = await prisma.player.findMany({
    include: {
      wallet: true,
      city: { include: { buildings: true } },
      transactions: { orderBy: { createdAt: 'asc' } },
      quests: true,
      units: true,
    },
  })
  if (players.length === 0) push('V2-players', 'no players found (run db:seed)')

  for (const player of players) {
    const label = `player:${player.name}`

    if (!player.wallet) push('V2-wallet', `${label} has no resource wallet`)
    if (!player.city) push('V2-city', `${label} has no city`)
    if (player.transactions.length === 0) push('V2-ledger', `${label} has no ledger rows`)

    // V1: ledger reconciliation per resource
    const sums = new Map<string, bigint>()
    for (const t of player.transactions) {
      sums.set(t.resource, (sums.get(t.resource) ?? 0n) + t.delta)
      // balanceAfter chain: each row's balanceAfter must equal running Σdelta
      const running = sums.get(t.resource) ?? 0n
      if (running !== t.balanceAfter) {
        push(
          'V1-chain',
          `${label} ${t.resource} tx ${t.id}: balanceAfter ${t.balanceAfter} ≠ running Σdelta ${running}`,
        )
      }
    }
    if (player.wallet) {
      for (const [resource, column] of Object.entries(WALLET_COLUMNS)) {
        const ledgerSum = sums.get(resource) ?? 0n
        const walletValue = BigInt(
          (player.wallet as unknown as Record<string, bigint>)[column as string],
        )
        if (ledgerSum !== walletValue) {
          push('V1-reconcile', `${label} ${resource}: Σledger ${ledgerSum} ≠ wallet ${walletValue}`)
        }
      }
    }

    // V2: city has all 17 starter building types, exactly once
    if (player.city) {
      const types = player.city.buildings.map((b) => b.type).sort()
      const unique = new Set(types)
      if (unique.size !== types.length)
        push('V2-buildings', `${label} has duplicate building types`)
      if (types.length < 17)
        push('V2-buildings', `${label} city has ${types.length} buildings, expected ≥ 17`)
    }

    // V2: starter quests assigned
    if (player.quests.length === 0) push('V2-quests', `${label} has no quests assigned`)

    // V2: starter army present
    if (player.units.length === 0) push('V2-army', `${label} has no units`)
  }

  // ── V3: config references inside DB resolve ──────────────────────────────
  const dbUnits = await prisma.unit.findMany({ select: { id: true, strongAgainst: true } })
  const unitIds = new Set(dbUnits.map((u) => u.id))
  for (const u of dbUnits) {
    for (const c of (u.strongAgainst as Array<{ unitId: string }> | null) ?? []) {
      if (!unitIds.has(c.unitId))
        push('V3-unit-counters', `unit ${u.id} counters unknown unit ${c.unitId}`)
    }
  }

  const dbQuests = await prisma.quest.findMany({ select: { id: true, prerequisiteQuestIds: true } })
  const questIds = new Set(dbQuests.map((q) => q.id))
  for (const q of dbQuests) {
    for (const p of (q.prerequisiteQuestIds as string[] | null) ?? []) {
      if (!questIds.has(p)) push('V3-quest-prereqs', `quest ${q.id} requires unknown quest ${p}`)
    }
  }

  // ── V5: city coordinates unique (DB constraint backs this, verify data) ──
  const cities = await prisma.city.findMany({ select: { x: true, y: true, name: true } })
  const seen = new Set<string>()
  for (const c of cities) {
    const key = `${c.x},${c.y}`
    if (seen.has(key)) push('V5-coords', `duplicate city coordinates (${key}) on ${c.name}`)
    seen.add(key)
  }

  // ── V6 (Phase 25): SQLite concurrency posture — WAL journal mode ─────────
  // WAL is the read/write concurrency backbone of the dev driver (readers
  // never block the single writer). journal_mode IS persistent on the file,
  // so enabling here heals any fresh database that was created in DELETE
  // mode. On PostgreSQL this is a no-op (MVCC is built in).
  const mode = (await prisma.$queryRawUnsafe(`PRAGMA journal_mode`)) as Array<{
    journal_mode: string
  }>
  const journalMode = mode[0]?.journal_mode
  if (journalMode !== 'wal') {
    // PRAGMA journal_mode=WAL RETURNS the new mode as a row — Prisma rejects
    // result-returning statements on $executeRaw (P2010), so the switch goes
    // through $queryRawUnsafe and asserts the returned mode.
    const switched = (await prisma.$queryRawUnsafe(`PRAGMA journal_mode=WAL`)) as Array<{
      journal_mode: string
    }>
    if (switched[0]?.journal_mode !== 'wal') {
      push('V6-wal', `journal_mode is '${journalMode}' and could not be switched to WAL`)
    } else {
      console.log('  V6-wal: journal_mode upgraded DELETE → WAL (persistent)')
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (violations.length > 0) {
    console.error(`\n✗ DATABASE INVARIANT VIOLATIONS (${violations.length}):\n`)
    for (const v of violations) console.error(`  [${v.check}] ${v.detail}`)
    console.error('')
    return 1
  }

  console.log(
    `\n✓ Database invariants hold: ${players.length} players, ${units} units, ` +
      `${quests} quests, ${techs} technologies, ${items} items, ${achievements} achievements, ` +
      `${cities.length} cities — ledger reconciles exactly.\n`,
  )
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('db:verify crashed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
