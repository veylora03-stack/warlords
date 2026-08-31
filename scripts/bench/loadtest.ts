/**
 * WARLORDS — Load-test harness (Phase 25: Performance & Scalability).
 *
 * Benchmarks the LIVE server (dev server on :3000) the way the Mini App
 * would drive it: N virtual players authenticating through the real
 * Telegram initData exchange, then looping a weighted, read-heavy op mix
 * with a minority write path (train + cancel through the real economy
 * transaction). Measures per-endpoint latency (p50/p90/p95/p99/max), RPS,
 * error and typed-refusal counts, plus server-process RSS/CPU sampled from
 * /proc every second.
 *
 * Usage:
 *   bun scripts/bench/loadtest.ts --players 200 --duration 60 --label baseline
 *   bun scripts/bench/loadtest.ts --players 200 --duration 60 --label after-fixes
 *
 * Design rules:
 *  - Only PUBLIC route handlers are exercised (HTTP to :3000) — no service
 *    shortcuts, no DB shortcuts for game state.
 *  - Bench identities live in the isolated 9100027… range and are deleted
 *    at the end (cascades remove wallets/cities/queues/sessions).
 *  - Wallets are topped up ONCE via a direct fixture update so the write
 *    scenario exercises the happy path for the whole window (documented —
 *    insufficient-funds refusals are separately covered by the QA suites).
 *  - A warmup pass hits every endpoint per player first (Next dev compiles
 *    routes lazily) so p99 is not first-compile noise.
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
const PLAYER_COUNT = Math.max(1, Number(argOf('players', '200')))
const DURATION_SEC = Math.max(5, Number(argOf('duration', '60')))
const LABEL = argOf('label', 'run')
const WARMUP_PLAYERS = Math.max(1, Number(argOf('warmup-players', '0')))
const ONLY_OP = argOf('only-op', '')
const THINK_MS = Math.max(0, Number(argOf('think-ms', '0')))
const OUT_DIR = 'docs/bench'

const TG_PREFIX = '9100027'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const REGISTER_CONCURRENCY = 16

/** Weighted steady-state op mix (read-heavy, minority writes) — shares sum to 100. */
const OP_MIX: Array<{ op: string; weight: number }> = [
  { op: 'player_state', weight: 14 },
  { op: 'player_resources', weight: 10 },
  { op: 'city_view', weight: 14 },
  { op: 'city_catalog', weight: 9 },
  { op: 'army_catalog', weight: 9 },
  { op: 'notifications', weight: 10 },
  { op: 'season_view', weight: 10 },
  { op: 'season_ranking', weight: 12 },
  { op: 'auth_me', weight: 7 },
  { op: 'train_cancel', weight: 5 },
]

// ── Latency recorder ─────────────────────────────────────────────────────────

class Recorder {
  private samples = new Map<string, number[]>()
  private errors = new Map<string, number>()
  private refusals = new Map<string, number>()

  record(op: string, ms: number): void {
    let arr = this.samples.get(op)
    if (!arr) this.samples.set(op, (arr = []))
    arr.push(ms)
  }
  error(op: string): void {
    this.errors.set(op, (this.errors.get(op) ?? 0) + 1)
  }
  refusal(op: string): void {
    this.refusals.set(op, (this.refusals.get(op) ?? 0) + 1)
  }

  percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    return sorted[Math.max(0, idx)]!
  }

  summary(wallSec: number): string {
    const lines: string[] = []
    let total = 0
    let totalErrors = 0
    let totalRefusals = 0
    const rows: string[] = []
    for (const op of [...this.samples.keys()].sort()) {
      const arr = (this.samples.get(op) ?? []).slice().sort((a, b) => a - b)
      const n = arr.length
      total += n
      const err = this.errors.get(op) ?? 0
      const ref = this.refusals.get(op) ?? 0
      totalErrors += err
      totalRefusals += ref
      const avg = n ? (arr.reduce((a, b) => a + b, 0) / n).toFixed(0) : '0'
      rows.push(
        `| ${op} | ${n} | ${this.percentile(arr, 50).toFixed(0)} | ${this.percentile(arr, 90).toFixed(0)} | ${this.percentile(arr, 95).toFixed(0)} | ${this.percentile(arr, 99).toFixed(0)} | ${arr[n - 1]!.toFixed(0)} | ${avg} | ${err} | ${ref} |`,
      )
    }
    lines.push(
      '| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `**Total measured ops:** ${total} · errors: ${totalErrors} · typed refusals: ${totalRefusals} · wall RPS: ${(total / wallSec).toFixed(1)}`,
    )
    return lines.join('\n')
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
        cpuPercent = (jiffies - this.lastJiffies) / 100 / elapsedSec * 100
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
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `BenchLord${telegramId.slice(-3)}`,
      username: `bench_lord_${telegramId.slice(-4)}`,
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
  ip = '203.0.127.1',
): Promise<{ status: number; ok: boolean; code?: string; token?: string; itemId?: string; ms: number }> {
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
      signal: AbortSignal.timeout(30_000),
    })
    const ms = performance.now() - t0
    let ok = res.ok
    let code: string | undefined
    let parsedToken: string | undefined
    let parsedItemId: string | undefined
    if (res.status === 200) {
      try {
        const parsed = (await res.json()) as {
          ok?: boolean
          data?: { token?: string; item?: { id: string } }
        }
        ok = parsed.ok === true
        parsedToken = parsed.data?.token
        parsedItemId = parsed.data?.item?.id
      } catch {
        /* 200 with non-JSON body */
      }
    } else {
      try {
        const parsed = (await res.json()) as { ok?: boolean; error?: { code?: string } }
        ok = parsed.ok === true
        code = parsed.error?.code
      } catch {
        /* non-JSON error body */
      }
    }
    return { status: res.status, ok, code, token: parsedToken, itemId: parsedItemId, ms }
  } catch {
    return { status: 0, ok: false, code: 'NETWORK', ms: performance.now() - t0 }
  }
}

// ── Registration & fixtures ──────────────────────────────────────────────────

interface BenchPlayer {
  telegramId: string
  token: string
  /** One device = one last-hop IP (rate limiter is identity/IP-keyed). */
  ip: string
}

async function registerPlayers(count: number): Promise<BenchPlayer[]> {
  const players: BenchPlayer[] = []
  let next = 1
  const worker = async () => {
    while (true) {
      const slot = next++
      if (slot > count) return
      const telegramId = `${TG_PREFIX}${String(slot).padStart(4, '0')}`
      const ip = `203.0.127.${(slot % 254) + 1}`
      const res = await call('POST', '/api/v1/auth/telegram', null, {
        initData: buildInitData(telegramId),
      }, ip)
      if (res.status === 429) {
        // IP-keyed pre-auth throttle — back off and retry the identity.
        await new Promise((r) => setTimeout(r, 2000))
        next--
        continue
      }
      if (res.status !== 200 || !res.token) {
        throw new Error(
          `registration failed for ${telegramId}: status ${res.status} code ${res.code}`,
        )
      }
      players.push({ telegramId, token: res.token, ip })
    }
  }
  await Promise.all(Array.from({ length: REGISTER_CONCURRENCY }, () => worker()))
  return players
}

/** Bench fixture: generous wallets so the write path exercises the happy
 *  path for the whole window (isolated range; deleted with the players). */
async function topUpWallets(): Promise<void> {
  const { db } = await import('../../src/lib/db')
  const { withWriteRetry } = await import('../../src/lib/game/services/player-registration.service')
  const rows = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  await withWriteRetry(() =>
    db.resourceWallet.updateMany({
      where: { playerId: { in: rows.map((r) => r.id) } },
      data: { gold: 50_000_000n, food: 50_000_000n, iron: 50_000_000n, wood: 50_000_000n },
    }),
  )
  await db.$disconnect()
}

async function cleanup(): Promise<void> {
  const { db } = await import('../../src/lib/db')
  const { withWriteRetry } = await import('../../src/lib/game/services/player-registration.service')
  await withWriteRetry(() =>
    db.user.deleteMany({ where: { telegramId: { startsWith: TG_PREFIX } } }),
  )
  await db.$disconnect()
}

// ── The op implementations ───────────────────────────────────────────────────

type Op = (p: BenchPlayer) => Promise<{ status: number; ok: boolean; code?: string; ms: number }>

const OPS: Record<string, Op> = {
  player_state: (p) => call('GET', '/api/v1/player/state', p.token, undefined, p.ip),
  player_resources: (p) => call('GET', '/api/v1/player/resources', p.token, undefined, p.ip),
  city_view: (p) => call('GET', '/api/v1/city', p.token, undefined, p.ip),
  city_catalog: (p) => call('GET', '/api/v1/city/buildings', p.token, undefined, p.ip),
  army_catalog: (p) => call('GET', '/api/v1/army/catalog', p.token, undefined, p.ip),
  notifications: (p) => call('GET', '/api/v1/player/notifications', p.token, undefined, p.ip),
  season_view: (p) => call('GET', '/api/v1/season', p.token, undefined, p.ip),
  season_ranking: (p) => call('GET', '/api/v1/season/ranking?limit=50', p.token, undefined, p.ip),
  auth_me: (p) => call('GET', '/api/v1/auth/me', p.token, undefined, p.ip),
  // Real write path: enqueue a batch through the economy tx, then cancel it
  // (50% in-progress refund — bench wallets are topped up, net cost small).
  // Latency = full train+cancel cycle.
  train_cancel: async (p) => {
    const start = await call('POST', '/api/v1/army/train', p.token, {
      unitId: 'swordsman',
      count: 1,
    }, p.ip)
    if (!start.ok || !start.itemId) {
      return { status: start.status, ok: false, code: start.code ?? 'NO_ITEM_ID', ms: start.ms }
    }
    const cancel = await call('POST', `/api/v1/army/train/${start.itemId}/cancel`, p.token)
    return { ...cancel, ms: start.ms + cancel.ms }
  },
}

/** Weighted op picker. */
function pickOp(): string {
  if (ONLY_OP) return ONLY_OP
  const total = OP_MIX.reduce((a, o) => a + o.weight, 0)
  let roll = Math.random() * total
  for (const { op, weight } of OP_MIX) {
    roll -= weight
    if (roll <= 0) return op
  }
  return 'player_state'
}

// ── Phases ───────────────────────────────────────────────────────────────────

const recorder = new Recorder()
const sys = new SysSampler()

async function warmup(players: BenchPlayer[]): Promise<void> {
  // warmup-players bounds the CONCURRENT warmup fan-out — on badly
  // contending builds the full fan-out can itself collapse the DB, hiding
  // the measured window behind warmup. 0 = all players (default).
  const slice =
    WARMUP_PLAYERS > 0 ? players.slice(0, WARMUP_PLAYERS) : players
  for (let round = 0; round < 2; round++) {
    await Promise.all(
      slice.map(async (p) => {
        for (const op of Object.keys(OPS)) {
          if (op === 'train_cancel') continue
          await OPS[op]!(p)
        }
      }),
    )
  }
  console.log('warmup complete — every route compiled')
}

async function runLoad(players: BenchPlayer[]): Promise<void> {
  const deadline = Date.now() + DURATION_SEC * 1000
  await Promise.all(
    players.map(async (p) => {
      let backoffUntil = 0
      while (Date.now() < deadline) {
        if (Date.now() < backoffUntil) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
        // Human think time — the MVP offer model: each online player acts
        // every few seconds, not in a zero-think open-loop hammer.
        if (THINK_MS > 0) {
          await new Promise((r) => setTimeout(r, THINK_MS * (0.75 + Math.random() * 0.5)))
        }
        const opName = pickOp()
        const result = await OPS[opName]!(p)
        recorder.record(opName, result.ms)
        if (result.ok) continue
        if (result.status >= 500 || result.status === 0) recorder.error(opName)
        else {
          recorder.refusal(opName)
          backoffUntil = Date.now() + 250 // never hammer a refusing server
        }
      }
    }),
  )
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN required in env (.env)')
  console.log(
    `WARLORDS load test — label=${LABEL} players=${PLAYER_COUNT} duration=${DURATION_SEC}s target=${BASE}`,
  )
  const pid = resolveServerPid()
  console.log(`server pid: ${pid ?? 'unknown'}`)

  await cleanup() // self-heal a crashed prior run's identity range

  console.log(`registering ${PLAYER_COUNT} players…`)
  const t0 = Date.now()
  const players = await registerPlayers(PLAYER_COUNT)
  console.log(`registered ${players.length} players in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  console.log('topping up bench wallets (isolated fixture range)…')
  await topUpWallets()

  console.log('warming up…')
  await warmup(players)

  sys.start()
  console.log(`measuring ${DURATION_SEC}s…`)
  const tStart = Date.now()
  await runLoad(players)
  const wallSec = (Date.now() - tStart) / 1000
  sys.stop()

  const report = [
    `# Load test — ${LABEL}`,
    '',
    `- players: ${PLAYER_COUNT} · window: ${wallSec.toFixed(1)}s · server pid: ${pid ?? 'unknown'}`,
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
