'use client'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useHealthQuery } from '@/features/system'
import { useMeQuery } from '@/features/auth'
import {
  usePlayerProfileQuery,
  usePlayerStateQuery,
  usePlayerStatisticsQuery,
} from '@/features/player'
import {
  ECONOMY_RESOURCE_LABELS,
  useResourcesQuery,
  useTransactionsQuery,
  type EconomyResourceView,
} from '@/features/economy'
import { useUiStore } from '@/stores/ui.store'

type PhaseState = 'done' | 'next' | 'planned'

interface PhaseRow {
  id: string
  name: string
  state: PhaseState
}

const PHASES: PhaseRow[] = [
  { id: '00', name: 'Architecture & Planning', state: 'done' },
  { id: '01', name: 'Project Foundation (tooling · config · logging · tests)', state: 'done' },
  {
    id: '02',
    name: 'Database Foundation (31-table schema · migration · seeds · tx bootstrap)',
    state: 'done',
  },
  {
    id: '03',
    name: 'Telegram Authentication (initData HMAC · sessions · guard · replay defense)',
    state: 'done',
  },
  {
    id: '04',
    name: 'Player System (XP/Level curve · derived Power · statistics · energy · Profile APIs)',
    state: 'done',
  },
  {
    id: '05',
    name: 'Resource & Economy Engine (ledger · caps · idempotent grants · concurrency)',
    state: 'done',
  },
  { id: '06?', name: 'City & Buildings (proposed)', state: 'next' },
  { id: '—', name: 'Army & Training', state: 'planned' },
  { id: '—', name: 'Battle Engine', state: 'planned' },
  { id: '—', name: 'Quests, Ranking & World', state: 'planned' },
  { id: '—', name: 'Telegram Bot', state: 'planned' },
  { id: '—', name: 'Mini App UI (full client)', state: 'planned' },
  { id: '—', name: 'Admin Panel', state: 'planned' },
  { id: '—', name: 'Security Hardening & Deployment', state: 'planned' },
]

const DELIVERABLES = [
  {
    label: 'Economy engine — single server-side write path, BigInt math',
    file: 'src/lib/game/services/economy.service.ts',
  },
  {
    label: 'Data-driven economy config — caps · ±1e15 ceiling · reason catalog',
    file: 'src/lib/game/config/economy.ts',
  },
  {
    label: 'Ledger-first writes — clamped deltas, Σdelta == balance invariant',
    file: 'resource_transactions (append-only)',
  },
  {
    label: 'Duplicate-reward guard — idempotency keys committed with the payout',
    file: 'grantResources (idempotencyKey)',
  },
  {
    label: 'Race safety — per-player FIFO mutex + conditional debit guard + retry',
    file: 'src/lib/concurrency/mutex.ts',
  },
  {
    label: 'Audited admin adjustments — before/after balances, operator identity',
    file: 'adminAdjustResources',
  },
  {
    label: 'Read APIs — GET /player/resources · GET /player/transactions (GET-only)',
    file: 'src/app/api/v1/player/resources|transactions/',
  },
  {
    label:
      'All six scenarios tested — negative · duplicate · concurrent · overflow · unauthorized · rollback',
    file: 'tests/integration/economy/',
  },
]

const STACK = [
  'Next.js 16 · App Router',
  'TypeScript 5 (strict)',
  'Tailwind CSS 4 + shadcn/ui',
  'Prisma ORM · PostgreSQL-first',
  'Zod v4 validation',
  'Zustand + TanStack Query',
  'bun test · Prettier · ESLint boundaries',
  'Telegram Bot API + Mini App',
]

const SHORT_CODE: Record<string, string> = {
  GOLD: 'Au',
  WOOD: 'Wd',
  IRON: 'Ir',
  FOOD: 'Fd',
  CRYSTAL: 'Cr',
  GEMS: 'Gm',
}

function formatAmount(raw: string): string {
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value.toLocaleString('en-US') : raw
}

function formatSignedDelta(raw: string): string {
  const value = BigInt(raw)
  const formatted = formatAmount(raw)
  return value > 0n ? `+${formatted}` : formatted
}

function formatTime(iso: string): string {
  return iso.slice(11, 19)
}

function headroomPct(entry: EconomyResourceView): number {
  const balance = Number(entry.balance)
  const cap = Number(entry.cap)
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(cap) || cap <= 0) return 0
  return Math.min(100, Math.round((balance / cap) * 100))
}

function PhaseBadge({ state }: { state: PhaseState }) {
  if (state === 'done') {
    return (
      <Badge className="bg-amber-500/15 text-amber-400 border border-amber-500/40 font-semibold">
        ✓ COMPLETE
      </Badge>
    )
  }
  if (state === 'next') {
    return (
      <Badge className="bg-orange-500/15 text-orange-400 border border-orange-500/40 font-semibold">
        ▶ NEXT
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-zinc-700 text-zinc-500 font-medium">
      PLANNED
    </Badge>
  )
}

export default function WarlordsConsole() {
  const autoRefresh = useUiStore((s) => s.autoRefresh)
  const toggleAutoRefresh = useUiStore((s) => s.toggleAutoRefresh)
  const { data: health, error: healthError } = useHealthQuery({ enabled: autoRefresh })
  const { data: me, error: meError, isPending: mePending } = useMeQuery()

  const signedIn = Boolean(me)
  const { data: profile, isPending: profilePending } = usePlayerProfileQuery({
    enabled: signedIn,
  })
  const { data: state } = usePlayerStateQuery({ enabled: signedIn })
  const { data: statistics } = usePlayerStatisticsQuery({ enabled: signedIn })
  const { data: wallet } = useResourcesQuery({ enabled: signedIn })
  const { data: ledger } = useTransactionsQuery({ enabled: signedIn, limit: 8 })

  const xpPct = profile ? Math.min(100, Math.round(profile.levelProgressBps / 100)) : 0
  const energyPct = profile
    ? Math.round((profile.energy / Math.max(1, profile.energyMax)) * 100)
    : 0

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-amber-500/30">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-500/80">
                Telegram MMO Strategy
              </p>
              <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-5xl">
                ⚔️ WAR<span className="text-amber-400">LORDS</span>
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
                Persistent server-authoritative strategy world — Bot + Mini App + REST API. This
                console tracks real engineering progress. Nothing here is a mockup.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <Badge className="bg-amber-500 px-3 py-1 text-sm font-bold text-zinc-950">
                PHASE 5 COMPLETE
              </Badge>
              <span className="font-mono text-xs text-zinc-500">
                {health ? `v${health.version}` : 'v—'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2">
          {/* System status — live from /api/health via TanStack Query */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                System Status
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    health?.db === 'up' ? 'text-emerald-400' : 'text-red-400'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      health?.db === 'up' ? 'bg-emerald-400' : 'bg-red-400'
                    }`}
                  />
                  {healthError
                    ? 'API ERROR'
                    : health?.db === 'up'
                      ? autoRefresh
                        ? 'DATABASE UP'
                        : 'UP · PAUSED'
                      : 'DB DOWN'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 font-mono text-xs text-zinc-400">
              {healthError ? (
                <p className="text-red-400">{healthError.message}</p>
              ) : health ? (
                <>
                  <div className="flex justify-between">
                    <span>db_latency</span>
                    <span className="text-zinc-200">{health.dbLatencyMs ?? '—'} ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span>uptime_sec</span>
                    <span className="text-zinc-200">{health.uptimeSec}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>status</span>
                    <span className="text-zinc-200">{health.status}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>engine</span>
                    <span className="text-zinc-200">Next.js 16 · Node</span>
                  </div>
                </>
              ) : (
                <p className="animate-pulse text-zinc-500">probing /api/health …</p>
              )}
              <Separator className="bg-zinc-800" />
              <div className="flex items-center justify-between">
                <label htmlFor="auto-refresh" className="cursor-pointer">
                  auto-refresh (15s)
                </label>
                <Switch
                  id="auto-refresh"
                  checked={autoRefresh}
                  onCheckedChange={toggleAutoRefresh}
                  aria-label="Toggle health auto-refresh"
                />
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Probe performs a real <span className="text-amber-400">SELECT 1</span> through
                Prisma against the database — the same path game traffic will use.
              </p>
            </CardContent>
          </Card>

          {/* Session — live from /api/v1/auth/me via TanStack Query */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                Session
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    me ? 'text-emerald-400' : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      me ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {meError ? 'AUTH ERROR' : me ? 'SIGNED IN' : 'ANONYMOUS'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 font-mono text-xs text-zinc-400">
              {meError ? (
                <p className="text-red-400">{meError.message}</p>
              ) : me ? (
                <>
                  <div className="flex justify-between">
                    <span>identity</span>
                    <span className="text-zinc-200">tg:{me.user.telegramId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>name</span>
                    <span className="text-zinc-200">
                      {me.user.firstName}
                      {me.user.username ? ` (@${me.user.username})` : ''}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>player</span>
                    <span className="text-zinc-200">
                      {me.player ? `${me.player.name} · lv${me.player.level}` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>session_exp</span>
                    <span className="text-zinc-200">
                      {new Date(me.session.expiresAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>role</span>
                    <span className="text-zinc-200">{me.user.role}</span>
                  </div>
                </>
              ) : mePending ? (
                <p className="animate-pulse text-zinc-500">probing /api/v1/auth/me …</p>
              ) : (
                <>
                  <p className="leading-relaxed text-zinc-500">
                    No session — the browser is anonymous. In production, Telegram opens the Mini
                    App with signed initData exchanged at{' '}
                    <span className="text-amber-400">POST /api/v1/auth/telegram</span>.
                  </p>
                  <p className="leading-relaxed text-zinc-500">
                    Dev: <span className="text-amber-400">POST /api/v1/auth/dev-impersonate</span>{' '}
                    (allowlisted + audited) issues a test session.
                  </p>
                </>
              )}
              <Separator className="bg-zinc-800" />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                initData is verified with Telegram&apos;s official HMAC-SHA256 algorithm — the bot
                token and JWT secret never leave the server. Replay of identical initData
                re-attaches to the same session instead of minting a new one.
              </p>
            </CardContent>
          </Card>

          {/* Player System — live from /api/v1/player/* via TanStack Query */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                Player System
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    profile ? 'text-emerald-400' : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      profile ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {profile ? 'PLAYER STATE LIVE' : signedIn ? 'NO PLAYER' : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {profile ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span>warlord</span>
                        <span className="text-zinc-200">{profile.name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>level</span>
                        <span className="text-amber-400">
                          {profile.level} <span className="text-zinc-500">(xp {profile.xp})</span>
                        </span>
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between">
                          <span>xp_progress</span>
                          <span className="text-zinc-300">
                            {profile.xpIntoLevel}/{profile.xpForNextLevel || 'MAX'}
                          </span>
                        </div>
                        <Progress
                          value={xpPct}
                          aria-label="XP progress toward next level"
                          className="h-1.5 bg-zinc-800"
                        />
                      </div>
                      <div className="flex justify-between">
                        <span>power</span>
                        <span className="text-zinc-200">
                          {profile.power}{' '}
                          <span className="text-zinc-500">
                            (army {profile.powerBreakdown.units} · bld{' '}
                            {profile.powerBreakdown.buildings} · tech{' '}
                            {profile.powerBreakdown.technologies})
                          </span>
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>honor / reputation</span>
                        <span className="text-zinc-200">
                          {profile.honor} · {profile.reputation}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <div className="mb-1 flex justify-between">
                          <span>energy</span>
                          <span className="text-zinc-300">
                            {profile.energy}/{profile.energyMax}
                          </span>
                        </div>
                        <Progress
                          value={energyPct}
                          aria-label="Energy pool"
                          className="h-1.5 bg-zinc-800"
                        />
                      </div>
                      <div className="flex justify-between">
                        <span>city</span>
                        <span className="text-zinc-200">
                          {state?.profile.city
                            ? `${state.profile.city.name} (${state.profile.city.x},${state.profile.city.y})`
                            : profile.city
                              ? `${profile.city.x},${profile.city.y}`
                              : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>wallet</span>
                        <span className="text-zinc-200">
                          {state
                            ? `Au ${state.wallet.gold} · Wd ${state.wallet.wood} · Ir ${state.wallet.iron} · Fd ${state.wallet.food} · Cr ${state.wallet.crystal}`
                            : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>army / buildings</span>
                        <span className="text-zinc-200">
                          {state
                            ? `${state.army.reduce((sum, u) => sum + u.count, 0)} units · ${state.buildingCount} bld`
                            : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>lifetime (stats)</span>
                        <span className="text-zinc-200">
                          {statistics
                            ? `wins ${statistics.statistics['battlesWon'] ?? 0} · trained ${statistics.statistics['unitsTrained'] ?? 0} · collected ${statistics.statistics['resourcesCollected'] ?? 0}`
                            : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Separator className="bg-zinc-800" />
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Level derives from total XP through the data-driven curve; power is recomputed
                    from the real army/buildings/technology state on every request — neither value
                    can be set or forged by a client.
                  </p>
                </>
              ) : profilePending && signedIn ? (
                <p className="animate-pulse text-zinc-500">probing /api/v1/player/state …</p>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no player projection available — first login bootstraps Player → City → Initial Resources in one transaction.'
                    : 'Anonymous — sign in (dev-impersonate in non-production) and the server bootstraps Player → City → Initial Resources on first login.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Resource & Economy Engine — live from /api/v1/player/{resources,transactions} */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                Resource &amp; Economy Engine
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    wallet ? 'text-emerald-400' : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      wallet ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {wallet ? 'LEDGER LIVE' : signedIn ? 'NO WALLET' : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {wallet ? (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    {/* Wallet — six resources with caps + headroom */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        Wallet · balance / cap
                      </p>
                      {wallet.resources.map((entry) => (
                        <div key={entry.key}>
                          <div className="flex justify-between">
                            <span>
                              <span className="text-amber-400/90">{SHORT_CODE[entry.key]}</span>{' '}
                              {ECONOMY_RESOURCE_LABELS[entry.key] ?? entry.key}
                            </span>
                            <span className="text-zinc-200">
                              {formatAmount(entry.balance)}
                              <span className="text-zinc-500"> / {formatAmount(entry.cap)}</span>
                            </span>
                          </div>
                          <Progress
                            value={headroomPct(entry)}
                            aria-label={`${entry.key} balance toward cap`}
                            className="mt-1 h-1 bg-zinc-800"
                          />
                        </div>
                      ))}
                    </div>
                    {/* Ledger — recent deltas, each with its reason */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        Resource Ledger · newest first
                      </p>
                      {ledger && ledger.entries.length > 0 ? (
                        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                          {ledger.entries.map((entry) => (
                            <div
                              key={entry.id}
                              className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5"
                            >
                              <span className="text-zinc-400">
                                {formatTime(entry.createdAt)}{' '}
                                <span className="text-amber-400/90">
                                  {SHORT_CODE[entry.resource] ?? entry.resource}
                                </span>
                              </span>
                              <span className="flex items-center gap-2">
                                <span
                                  className={
                                    BigInt(entry.delta) > 0n ? 'text-emerald-400' : 'text-red-400'
                                  }
                                >
                                  {formatSignedDelta(entry.delta)}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-400"
                                >
                                  {entry.reason}
                                </Badge>
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-zinc-500">no ledger activity yet</p>
                      )}
                    </div>
                  </div>
                  <Separator className="bg-zinc-800" />
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Ledger-first economy: every delta appends to{' '}
                    <span className="text-amber-400">resource_transactions</span> with a reason
                    (QUEST_REWARD · BUILDING_UPGRADE · UNIT_TRAINING · BATTLE_REWARD · MARKET_* ·
                    ADMIN_ADJUSTMENT) and the resulting balance — Σdelta == balance per resource.
                    Credits clamp at data-driven caps; debits are balance-guarded; the HTTP surface
                    is read-only (GET) — every mutation is server-side and transactional.
                  </p>
                </>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no wallet projection available — first login bootstraps Player → City → Initial Resources in one transaction.'
                    : 'Anonymous — sign in (dev-impersonate in non-production) to inspect the live ledger-backed wallet.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Architecture at a glance */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold text-zinc-100">
                Architecture at a Glance
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs leading-relaxed text-zinc-400">
              <ul className="space-y-2">
                <li>
                  <span className="font-semibold text-amber-400">Bot + Mini App</span> → Telegram
                  clients; Mini App is the full game UI.
                </li>
                <li>
                  <span className="font-semibold text-amber-400">REST /api/v1</span> → thin HTTP
                  adapters over application services.
                </li>
                <li>
                  <span className="font-semibold text-amber-400">Engines (pure)</span> → economy ·
                  battle (seeded & replayable) · quest · progress · world.
                </li>
                <li>
                  <span className="font-semibold text-amber-400">Ledger economy</span> → every
                  resource delta appended, auditable, non-negative by construction.
                </li>
                <li>
                  <span className="font-semibold text-amber-400">Lazy-tick world</span> → production
                  & timers resolve on access; no cron dependency.
                </li>
              </ul>
              <Separator className="bg-zinc-800" />
              <div className="flex flex-wrap gap-1.5">
                {STACK.map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400"
                  >
                    {s}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Phase roadmap */}
        <Card className="mt-6 border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-zinc-100">
              Development Roadmap — Phase Contracts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="divide-y divide-zinc-800/70">
              {PHASES.map((p) => (
                <li key={p.name} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`w-9 shrink-0 text-right font-mono text-sm font-bold ${
                        p.state === 'done' ? 'text-amber-400' : 'text-zinc-600'
                      }`}
                    >
                      {p.id}
                    </span>
                    <span
                      className={`min-w-0 flex-1 text-sm leading-snug ${
                        p.state === 'done'
                          ? 'font-semibold text-zinc-100'
                          : p.state === 'next'
                            ? 'text-zinc-300'
                            : 'text-zinc-500'
                      }`}
                    >
                      {p.name}
                    </span>
                  </div>
                  <PhaseBadge state={p.state} />
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Phase 5 deliverables */}
        <Card className="mt-6 border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-zinc-100">
              Phase 5 — Resource &amp; Economy Engine Deliverables
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {DELIVERABLES.map((d) => (
              <div
                key={d.file}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <span className="min-w-0 text-xs text-zinc-300">{d.label}</span>
                <code className="min-w-0 shrink text-right font-mono text-[10px] leading-snug text-amber-500/90 [overflow-wrap:anywhere]">
                  {d.file}
                </code>
              </div>
            ))}
            <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 sm:col-span-2">
              <span className="min-w-0 text-xs text-zinc-300 [overflow-wrap:anywhere]">
                Quality gate — lint · typecheck · format · unit + integration + e2e tests ·
                production build · negative/duplicate/concurrent/overflow/unauthorized/rollback
                green
              </span>
              <code className="min-w-0 shrink text-right font-mono text-[10px] leading-snug text-amber-400 [overflow-wrap:anywhere]">
                wallet ✓ ledger ✓ grants ✓ caps ✓ tests ✓
              </code>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ── Sticky footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-1 px-4 py-4 text-[11px] text-zinc-600 sm:flex-row sm:px-6">
          <span>
            WARLORDS Dev Console · Phase 5 · awaiting approval for Phase 6 (City &amp; Buildings)
          </span>
          <span className="font-mono">server-authoritative · never trust the client</span>
        </div>
      </footer>
    </div>
  )
}
