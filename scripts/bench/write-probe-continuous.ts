/**
 * Continuous write probe (Phase 25 diagnostic): loops a no-op write and
 * logs any sample above 100ms with a timestamp, so a concurrent load window
 * can be correlated against external write-lock availability.
 */
import { db } from '../../src/lib/db'

async function main(): Promise<void> {
  const durationSec = Number(process.argv[2] ?? '60')
  const deadline = Date.now() + durationSec * 1000
  let n = 0
  let slow = 0
  let max = 0
  const latencies: number[] = []
  while (Date.now() < deadline) {
    const t0 = performance.now()
    await db.$executeRawUnsafe(
      'UPDATE resources SET updatedAt = updatedAt WHERE playerId = (SELECT playerId FROM resources LIMIT 1)',
    )
    const ms = performance.now() - t0
    latencies.push(ms)
    n++
    if (ms > 100) {
      slow++
      console.log(`SLOW-WRITE ${new Date().toISOString()} ${ms.toFixed(0)}ms`)
    }
    max = Math.max(max, ms)
    await new Promise((r) => setTimeout(r, 100))
  }
  latencies.sort((a, b) => a - b)
  console.log(
    `CONTINUOUS PROBE: n=${n} slow(>100ms)=${slow} max=${max.toFixed(1)} p50=${latencies[Math.floor(n / 2)]!.toFixed(1)} p95=${latencies[Math.floor(n * 0.95)]!.toFixed(1)} ms`,
  )
  await db.$disconnect()
  process.exit(0)
}

await main()
