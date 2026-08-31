/**
 * Raw SQLite MULTI-PROCESS concurrency probe (Phase 25 diagnostic).
 *
 * Spawns N independent bun child processes, each opening its OWN connection
 * to the same WAL-mode database and running BEGIN IMMEDIATE → UPDATE →
 * COMMIT cycles — the true multi-connection contention model that a
 * connection pool approximates. If real processes are fast where the
 * server's pooled transactions stall, the Prisma layer is the bottleneck.
 *
 * Usage: bun scripts/bench/raw-sqlite-processes.ts [concurrency]
 */
import { spawnSync } from 'node:child_process'

const concurrency = Number(process.argv[2] ?? '8')
const CYCLES = 5

const workerScript = `
import { Database } from 'bun:sqlite'
const db = new Database('db/custom.db')
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA busy_timeout=5000')
const lat = []
for (let i = 0; i < ${CYCLES}; i++) {
  const t0 = performance.now()
  db.run('BEGIN IMMEDIATE')
  db.run("UPDATE resources SET updatedAt = updatedAt WHERE playerId = (SELECT playerId FROM resources LIMIT 1)")
  db.run('COMMIT')
  lat.push(performance.now() - t0)
}
console.log(JSON.stringify(lat))
db.close()
`

const t0 = performance.now()
const procs = Array.from({ length: concurrency }, () =>
  spawnSync('bun', ['-e', workerScript], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }),
)
const wall = performance.now() - t0

const all: number[] = []
let failures = 0
for (const p of procs) {
  if (p.status !== 0) {
    failures++
    continue
  }
  const line = p.stdout.trim().split('\n').pop() ?? '[]'
  try {
    all.push(...(JSON.parse(line) as number[]))
  } catch {
    failures++
  }
}
all.sort((a, b) => a - b)
if (all.length === 0) {
  console.log('all worker processes failed')
  process.exit(1)
}
const p50 = all[Math.floor(all.length / 2)]!
const max = all[all.length - 1]!
console.log(
  `multi-process concurrency=${concurrency}: ops=${all.length} p50=${p50.toFixed(1)}ms max=${max.toFixed(1)}ms wall=${wall.toFixed(0)}ms failures=${failures}`,
)
