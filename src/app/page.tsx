'use client'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useHealthQuery } from '@/features/system'
import { useUiStore } from '@/stores/ui.store'

type PhaseState = 'done' | 'next' | 'planned'

interface PhaseRow {
  id: string
  name: string
  state: PhaseState
}

const PHASES: PhaseRow[] = [
  { id: '00', name: 'Architecture & Planning', state: 'done' },
  { id: '01a', name: 'Project Foundation (tooling · config · logging · tests)', state: 'done' },
  { id: '01b', name: 'Database & Authentication', state: 'next' },
  { id: '02', name: 'Player, Resources & Economy Core', state: 'planned' },
  { id: '03', name: 'City & Buildings', state: 'planned' },
  { id: '04', name: 'Army & Training', state: 'planned' },
  { id: '05', name: 'Battle Engine', state: 'planned' },
  { id: '06', name: 'Quests, Ranking & World', state: 'planned' },
  { id: '07', name: 'Telegram Bot', state: 'planned' },
  { id: '08', name: 'Mini App UI (full client)', state: 'planned' },
  { id: '09', name: 'Admin Panel', state: 'planned' },
  { id: '10', name: 'Security Hardening & Test Pass', state: 'planned' },
  { id: '11', name: 'Deployment Preparation', state: 'planned' },
  { id: '12', name: 'Load Testing', state: 'planned' },
  { id: '13', name: 'Polish & Balance', state: 'planned' },
]

const DELIVERABLES = [
  { label: 'Env config layer (Zod-validated, fail-fast)', file: 'src/config/env.ts' },
  { label: 'Structured JSON logger (levels · redaction)', file: 'src/lib/logger/' },
  {
    label: 'Route factory (Zod → envelope) + request logging',
    file: 'src/lib/api/route-handler.ts',
  },
  { label: 'Health module (service/types/barrel pattern)', file: 'src/lib/health/' },
  { label: 'Frontend providers (TanStack Query) + feature slice', file: 'src/features/system/' },
  { label: 'UI state store (Zustand)', file: 'src/stores/ui.store.ts' },
  { label: 'Unit tests (bun test) + e2e API smoke', file: 'tests/' },
  { label: 'Formatter + import-boundary lint rules', file: '.prettierrc.json' },
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
                PHASE 1A COMPLETE
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
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
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

        {/* Phase 1 deliverables */}
        <Card className="mt-6 border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-zinc-100">
              Phase 1a — Foundation Deliverables
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {DELIVERABLES.map((d) => (
              <div
                key={d.file}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <span className="text-xs text-zinc-300">{d.label}</span>
                <code className="shrink-0 font-mono text-[10px] text-amber-500/90">{d.file}</code>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 sm:col-span-2">
              <span className="text-xs text-zinc-300">
                Quality gate — build · lint · typecheck · unit + e2e tests all green
              </span>
              <code className="shrink-0 font-mono text-[10px] text-amber-400">
                bun test ✓ tsc ✓ eslint ✓
              </code>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ── Sticky footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-1 px-4 py-4 text-[11px] text-zinc-600 sm:flex-row sm:px-6">
          <span>
            WARLORDS Dev Console · Phase 1a · awaiting approval for Phase 1b (Database & Auth)
          </span>
          <span className="font-mono">server-authoritative · never trust the client</span>
        </div>
      </footer>
    </div>
  )
}
