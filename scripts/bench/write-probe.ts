/**
 * Write-latency probe (Phase 25 diagnostic): measures single-statement
 * autocommit write latency against the live SQLite file. Run standalone
 * while the server is idle vs under load to attribute lock stalls.
 */
import { db } from '../../src/lib/db'

async function main(): Promise<void> {
  const latencies: number[] = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    await db.$executeRawUnsafe(
      'UPDATE resources SET updatedAt = updatedAt WHERE playerId = (SELECT playerId FROM resources LIMIT 1)',
    )
    latencies.push(performance.now() - t0)
    await new Promise((r) => setTimeout(r, 200))
  }
  latencies.sort((a, b) => a - b)
  console.log(
    `WRITE PROBE: p50=${latencies[24]!.toFixed(1)} p90=${latencies[44]!.toFixed(1)} p95=${latencies[47]!.toFixed(1)} max=${latencies[49]!.toFixed(1)} ms (n=${latencies.length})`,
  )
  await db.$disconnect()
  process.exit(0)
}

await main()
