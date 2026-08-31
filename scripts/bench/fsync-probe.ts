/**
 * Fsync latency probe (Phase 25 diagnostic): measures WAL-commit-like
 * fsync cost on the sandbox disk, idle vs under whatever else is running.
 * This is the durability cost every SQLite commit pays in synchronous=FULL.
 */
import { openSync, closeSync, fsyncSync, writeSync, unlinkSync } from 'node:fs'

function main(): void {
  const path = 'db/.fsync-probe.tmp'
  const fd = openSync(path, 'w')
  const latencies: number[] = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    writeSync(fd, `probe ${i}\n`)
    fsyncSync(fd)
    latencies.push(performance.now() - t0)
  }
  closeSync(fd)
  unlinkSync(path)
  latencies.sort((a, b) => a - b)
  const p50 = latencies[49]!.toFixed(2)
  const p95 = latencies[94]!.toFixed(2)
  const max = latencies[99]!.toFixed(2)
  console.log(`FSYNC PROBE: p50=${p50}ms p95=${p95}ms max=${max}ms (n=100)`)
}

main()
