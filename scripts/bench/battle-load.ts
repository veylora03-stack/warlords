/**
 * WARLORDS — Battle Engine load test (Phase 28: Performance).
 *
 * Benchmarks the LIVE server (dev server on :3000) the way a raid wave hits
 * it: N unique attackers authenticate through the real Telegram initData
 * exchange, then EVERY attacker fires exactly one real attack through the
 * public POST /api/v1/battles/attack route — full pipeline (validation →
 * locks → energy CAS → deterministic simulation → casualties → ledger loot →
 * notifications) per request.
 *
 * Design rules (mirroring scripts/bench/loadtest.ts):
 *  - Only PUBLIC route handlers are exercised (HTTP to :3000) — no service
 *    shortcuts, no DB shortcuts for game state. The ONLY direct-DB fixture is
 *    defender backdating (newbie-shield bypass, documented) and cleanup.
 *  - Bench identities live in the isolated 9100030… range, deleted at the end
 *    (battles first — they Restrict-delete).
 *  - One attack per attacker: the 60s attack cooldown makes repeat fire from
 *    the same identity a typed 429, so concurrency = unique attackers.
 *  - Defender pool sized so the per-target daily raid cap (config) is never
 *    the bottleneck: defenders = ceil(attacks / (cap − 1)).
 *
 * Usage:
 *   bun scripts/bench/battle-load.ts --attacks 100 --label battle-100p
 *   bun scripts/bench/battle-load.ts --attacks 500 --label battle-500p
 */

import { createHmac } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// ── Configuration ────────────────────────────────────────────────────────────

const BASE = process.env['BENCH_BASE'] ?? 'http://localhost:3000'
const args = process.argv.slice(2)
function argOf(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const ATTACKS = Math.max(1, Number(argOf('attacks', '100')))
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', String(ATTACKS))))
const LABEL = argOf('label', `battle-${ATTACKS}p`)
const OUT_DIR = 'docs/bench'

const TG_PREFIX = '9100030'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const REGISTER_CONCURRENCY = 16
const RAID_CAP_MARGIN = 1 // defenders sized with one spare raid slot each

// ── Latency recorder ─────────────────────────────────────────────────────────

class Recorder {
  private samples: number[] = []
  private refusals = new Map<string, number>()
  private errors = new Map<string, number>()
  private okCount = 0

  record(ms: number): void {
    this.samples.push(ms)
  }
  ok(): void {
    this.okCount++
  }
  refusal(code: string): void {
    this.refusals.set(code, (this.refusals.get(code) ?? 0) + 1)
  }
  error(kind: string): void {
    this.errors.set(kind, (this.errors.get(kind) ?? 0) + 1)
  }

  percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    return sorted[Math.max(0, idx)]!
  }

  summary(wallSec: number): string {
    const sorted = [...this.samples].sort((a, b) => a - b)
    const n = sorted.length
    const avg = n ? (sorted.reduce((a, b) => a + b, 0) / n).toFixed(0) : '0'
    const refusalRows = [...this.refusals.entries()].sort(([a], [b]) => a.localeCompare(b))
    const errorRows = [...this.errors.entries()].sort(([a], [b]) => a.localeCompare(b))
    return [
      '| attacks | n | p50 | p90 | p95 | p99 | max | avg |',
      '|---|---|---|---|---|---|---|---|',
      `| POST /api/v1/battles/attack | ${n} | ${this.percentile(sorted, 50).toFixed(0)} | ${this.percentile(sorted, 90).toFixed(0)} | ${this.percentile(sorted, 95).toFixed(0)} | ${this.percentile(sorted, 99).toFixed(0)} | ${n ? sorted[n - 1]!.toFixed(0) : '0'} | ${avg} |`,
      '',
      `**Resolved battles (200):** ${this.okCount}/${ATTACKS} · wall time ${wallSec.toFixed(1)}s · throughput ${(n / wallSec).toFixed(1)} attacks/s`,
      '',
      `**Typed refusals:** ${refusalRows.length === 0 ? 'none' : refusalRows.map(([code, count]) => `${code}×${count}`).join(' · ')}`,
      '',
      `**Errors (5xx/network):** ${errorRows.length === 0 ? 'none' : errorRows.map(([kind, count]) => `${kind}×${count}`).join(' · ')}`,
    ].join('\n')
  }
}

// ── Process sampling (server RSS / CPU from /proc) ───────────────────────────

function resolveServerPid(): number | null {
  try {
    const out = execSync('ss -tlnp', { encoding: 'utf8' })
    const m = out.match(/:3000\s.*pid=(\d+)/)
    if (m) return Number(m[1])
  } catch {
    /* fall through */
  }
  return null
}

class SysSampler {
  private readonly pid: number | null
  private lastJiffies: number | null = null
  private lastAt = 0
  readonly samples: Array<{ rssMb: number; cpuPercent: number }> = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.pid = resolveServerPid()
  }

  start(): void {
    if (this.pid === null) {
      console.warn('WARN: could not resolve server pid — RSS/CPU sampling disabled')
      return
    }
    this.timer = setInterval(() => this.tick(), 1000)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private tick(): void {
    if (this.pid === null) return
    try {
      const stat = readFileSync(`/proc/${this.pid}/stat`, 'utf8')
      const parts = stat.split(' ')
      const jiffies = Number(parts[13]) + Number(parts[14])
      const now = Date.now()
      let cpuPercent = 0
      if (this.lastJiffies !== null) {
        const elapsedSec = (now - this.lastAt) / 1000
        cpuPercent = ((jiffies - this.lastJiffies) / 100 / elapsedSec) * 100
      }
      this.lastJiffies = jiffies
      this.lastAt = now
      const status = readFileSync(`/proc/${this.pid}/status`, 'utf8')
      const rssLine = status.split('\n').find((l) => l.startsWith('VmRSS'))
      const rssMb = rssLine ? Number(rssLine.split(/\s+/)[1]) / 1024 : 0
      this.samples.push({ rssMb, cpuPercent })
    } catch {
      this.stop()
    }
  }

  summary(): string {
    if (this.samples.length === 0) return '_server process sampling unavailable._'
    const rss = this.samples.map((s) => s.rssMb)
    const cpu = this.samples.map((s) => s.cpuPercent)
    const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)
    return `RSS avg ${avg(rss)} MB (min ${Math.min(...rss).toFixed(0)} / max ${Math.max(...rss).toFixed(0)}) · CPU avg ${avg(cpu)}% of one core (max ${Math.max(...cpu).toFixed(0)}%) · samples ${this.samples.length}`
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEBT000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `RaidLord${telegramId.slice(-3)}`,
      username: `raid_lord_${telegramId.slice(-4)}`,
      language_code: 'en',
    }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN!).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  token: string | null,
  body?: unknown,
  ip = '203.0.128.1',
): Promise<{
  status: number
  ok: boolean
  code?: string
  token?: string
  playerId?: string
  ms: number
}> {
  const t0 = performance.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-forwarded-for': ip,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    const ms = performance.now() - t0
    const parsed = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      data?: { token?: string; player?: { id?: string } }
      error?: { code?: string }
    }
    return {
      status: res.status,
      ok: parsed.ok === true,
      code: parsed.error?.code,
      token: parsed.data?.token,
      playerId: parsed.data?.player?.id,
      ms,
    }
  } catch (err) {
    return {
      status: 0,
      ok: false,
      code: err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
      ms: performance.now() - t0,
    }
  }
}

// ── Registration & fixtures ──────────────────────────────────────────────────

interface BenchPlayer {
  telegramId: string
  token: string
  playerId: string
}

async function registerBenchPlayers(count: number, offset: number): Promise<BenchPlayer[]> {
  const players: BenchPlayer[] = []
  let next = 1
  const worker = async () => {
    while (true) {
      const slot = next++
      if (slot > count) return
      const telegramId = `${TG_PREFIX}9${String(offset).padStart(2, '0')}${String(slot).padStart(5, '0')}`
      const ip = `203.0.129.${(slot % 254) + 1}`
      const res = await call(
        'POST',
        '/api/v1/auth/telegram',
        null,
        {
          initData: buildInitData(telegramId),
        },
        ip,
      )
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000))
        next--
        continue
      }
      if (res.status !== 200 || !res.token || !res.playerId) {
        throw new Error(
          `registration failed for ${telegramId}: status ${res.status} code ${res.code}`,
        )
      }
      players.push({ telegramId, token: res.token, playerId: res.playerId })
    }
  }
  await Promise.all(Array.from({ length: REGISTER_CONCURRENCY }, () => worker()))
  return players
}

/** Bench fixture: defenders must be past the newbie shield to be attackable. */
async function makeDefendersAttackable(playerIds: string[]): Promise<void> {
  const { db } = await import('../../src/lib/db')
  const { withWriteRetry } = await import('../../src/lib/game/services/player-registration.service')
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
  await withWriteRetry(() =>
    db.player.updateMany({
      where: { id: { in: playerIds } },
      data: { createdAt: twoWeeksAgo, level: 6, xp: 10_000n },
    }),
  )
  const users = await db.player.findMany({
    where: { id: { in: playerIds } },
    select: { userId: true },
  })
  await withWriteRetry(() =>
    db.user.updateMany({
      where: { id: { in: users.map((u) => u.userId) } },
      data: { lastLoginAt: new Date(Date.now() - 2 * 3600_000) },
    }),
  )
  await db.$disconnect()
}

async function cleanup(): Promise<void> {
  const { db } = await import('../../src/lib/db')
  const { withWriteRetry } = await import('../../src/lib/game/services/player-registration.service')
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
  if (ids.length > 0) {
    await withWriteRetry(() =>
      db.battle.deleteMany({
        where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
      }),
    )
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } }).catch(() => undefined)
  }
  await withWriteRetry(() =>
    db.user.deleteMany({ where: { telegramId: { startsWith: TG_PREFIX } } }),
  )
  await db.$disconnect()
}

// ── The benchmark ────────────────────────────────────────────────────────────

const recorder = new Recorder()
const sys = new SysSampler()

async function main(): Promise<void> {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN required in env (.env)')
  console.log(
    `WARLORDS battle load test — label=${LABEL} attacks=${ATTACKS} concurrency=${CONCURRENCY} target=${BASE}`,
  )
  const pid = resolveServerPid()
  console.log(`server pid: ${pid ?? 'unknown'}`)

  await cleanup() // self-heal a crashed prior run's identity range

  // Season must be ACTIVE for battles — create it through the seeded
  // scheduler if the world is fresh (direct service call, fixture-level).
  const { ensureActiveSeasonInTx } = await import('../../src/lib/game/services/season.service')
  const { runEconomyTransaction } = await import('../../src/lib/game/services/economy.service')
  await runEconomyTransaction('battle-bench', async (tx) => {
    await ensureActiveSeasonInTx(tx)
  })

  const defenderCount = Math.ceil(ATTACKS / Math.max(1, 5 - RAID_CAP_MARGIN))
  console.log(`registering ${ATTACKS} attackers + ${defenderCount} defenders…`)
  const t0 = Date.now()
  const [attackers, defenders] = await Promise.all([
    registerBenchPlayers(ATTACKS, 0),
    registerBenchPlayers(defenderCount, 50),
  ])
  console.log(
    `registered ${attackers.length + defenders.length} players in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )

  console.log('backdating defenders past the newbie shield (fixture)…')
  await makeDefendersAttackable(defenders.map((d) => d.playerId))

  // Warm the route (compile) without consuming any cooldown.
  await call('GET', '/api/v1/battles/targets', attackers[0]!.token)
  console.log('warmup complete')

  const pairs = attackers.map((attacker, index) => ({
    attacker,
    defender: defenders[index % defenders.length]!,
  }))

  sys.start()
  console.log(`measuring ${ATTACKS} attacks (concurrency ${CONCURRENCY})…`)
  const tStart = Date.now()
  let cursor = 0
  const worker = async () => {
    while (true) {
      const slot = cursor++
      if (slot >= pairs.length) return
      const { attacker, defender } = pairs[slot]!
      const result = await call(
        'POST',
        '/api/v1/battles/attack',
        attacker.token,
        { targetPlayerId: defender.playerId },
        `203.0.130.${(slot % 254) + 1}`,
      )
      recorder.record(result.ms)
      if (result.ok) {
        recorder.ok()
      } else if (result.status === 0 || result.status >= 500) {
        recorder.error(result.code ?? `HTTP_${result.status}`)
      } else {
        recorder.refusal(result.code ?? `HTTP_${result.status}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, () => worker()))
  const wallSec = (Date.now() - tStart) / 1000
  sys.stop()

  const report = [
    `# Battle Engine load test — ${LABEL}`,
    '',
    `- attacks: ${ATTACKS} · concurrency: ${CONCURRENCY} · defenders: ${defenderCount} · server pid: ${pid ?? 'unknown'}`,
    `- every attack is a REAL full-pipeline battle (validate → lock → energy → simulate → casualties → loot → notifications)`,
    `- server process: ${sys.summary()}`,
    '',
    recorder.summary(wallSec),
    '',
  ].join('\n')
  console.log(report)
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(`${OUT_DIR}/${LABEL}.md`, report)
  console.log(`saved → ${OUT_DIR}/${LABEL}.md`)

  await cleanup()
  process.exit(0)
}

await main()
