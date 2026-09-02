'use client'

/**
 * WARLORDS — Marches section for the Mini App console.
 *
 * Renders the LIVE server march list (GET /api/v1/marches) — type, route,
 * committed units, status and a LIVE countdown for in-flight legs — plus the
 * recall (POST cancel), server progress-check (POST process) and the Phase 34
 * STATIONED affordance: ARRIVED garrison marches carry a STATIONED badge and
 * a WITHDRAW button (POST /marches/[id]/withdraw) that starts the exactly-once
 * return leg.
 * Every value shown is server-computed — nothing here is mock, hard-coded or
 * optimistic: origin, distance, travel time, arrival, battle outcome and
 * homecoming are decided inside one globally serialized transaction. The
 * countdown is DISPLAY-ONLY: it is derived from the row's serverNowMs
 * snapshot plus a local 1s tick, so client clock skew can shift the display
 * but can never fake an arrival — only POST /marches/[id]/process advances
 * state, and it checks the server clock.
 *
 * Visual language matches the console: zinc/dark surfaces, amber accents,
 * text-[11px] uppercase tracking-wider labels, mono body text. Rows wrap and
 * truncate; the list scrolls inside max-h-96 — no horizontal overflow at
 * 390px.
 */

import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useCancelMarch, useMarches, useProcessMarch, useWithdrawMarch } from '../api/marches'
import type { MarchListView, MarchStackView, MarchStatus, MarchType, MarchView } from '../types'

// ── Static class lookups (never interpolate Tailwind class names) ────────────

/** March action → badge appearance (reserved RETURN included for safety). */
const MARCH_TYPE_BADGE: Record<MarchType, string> = {
  ATTACK: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  DEFEND: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  SCOUT: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  REINFORCE: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  RETURN: 'border-zinc-700 text-zinc-400',
}

const MARCH_TYPE_GLYPH: Record<MarchType, string> = {
  ATTACK: '⚔',
  DEFEND: '🛡',
  SCOUT: '👁',
  REINFORCE: '✚',
  RETURN: '↩',
}

/** Server status → distinct badge treatment. */
const MARCH_STATUS_BADGE: Record<MarchStatus, string> = {
  EN_ROUTE: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  RESOLVING: 'border-amber-500/30 bg-amber-500/5 text-amber-200',
  RETURNING: 'border-amber-500/30 bg-amber-500/5 text-amber-300',
  ARRIVED: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  COMPLETED: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300',
  CANCELLED: 'border-zinc-700 text-zinc-500',
  LOST: 'border-red-500/40 bg-red-500/10 text-red-300',
}

/** Typed recall refusal → human text (server error codes win). */
const CANCEL_ERROR_TEXT: Record<string, string> = {
  MARCH_NOT_CANCELLABLE: 'Too late to recall',
  MARCH_NOT_FOUND: 'March not found',
}

const PROCESS_ERROR_TEXT: Record<string, string> = {
  MARCH_NOT_FOUND: 'March not found',
}

/** Typed garrison-withdraw refusal → human text (server error codes win). */
const WITHDRAW_ERROR_TEXT: Record<string, string> = {
  MARCH_NOT_FOUND: 'March not found',
  MARCH_NOT_WITHDRAWABLE: 'Only a stationed garrison march can be withdrawn',
}

// ── Display helpers (pure, server data in — text out) ────────────────────────

/** "40× Swordsman · 5× Scout" — committed/surviving units summary. */
function stacksSummary(stacks: MarchStackView[]): string {
  return stacks.map((stack) => `${stack.count}× ${stack.unitName}`).join(' · ')
}

function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

function destinationText(march: MarchView): string {
  const dest = march.destination
  if (dest.x === null || dest.y === null) return 'unknown destination'
  return `(${dest.x},${dest.y})`
}

/** The in-flight leg's server-scheduled target, if one is running. */
function countdownTargetMs(march: MarchView): number | null {
  if (march.status === 'EN_ROUTE') return Date.parse(march.arrivesAt)
  if (march.status === 'RETURNING' && march.returnsAt !== null) return Date.parse(march.returnsAt)
  return null
}

/** Terminal/arrival summary — server outcome fields only, no local verdicts. */
function outcomeSummary(march: MarchView): string | null {
  const outcome = march.outcome
  if (march.status === 'CANCELLED') return 'recalled — the manifest returned to your army'
  if (march.status === 'LOST') {
    return typeof outcome?.unitsLost === 'number'
      ? `lost in action — ${outcome.unitsLost} units perished`
      : 'lost in action — no survivors'
  }
  if (march.status === 'ARRIVED') {
    // Phase 34 — the detachment is STATIONED as a positional garrison.
    if (march.type === 'DEFEND' || march.type === 'REINFORCE') {
      return 'detachment stationed — holding the garrison'
    }
    return 'arrived'
  }
  if (march.status !== 'COMPLETED' || !outcome) return null
  if (march.type === 'ATTACK') {
    if (outcome.aborted) return `aborted — ${outcome.aborted.replaceAll('_', ' ').toLowerCase()}`
    return outcome.captured ? 'captured ✓' : 'defense held'
  }
  if (march.type === 'SCOUT') {
    return outcome.scoutReportId ? 'recon delivered ✓' : 'recon complete'
  }
  if (march.type === 'DEFEND' || march.type === 'REINFORCE') {
    return outcome.delivered ? 'detachment delivered ✓' : 'detachment resolved'
  }
  return null
}

/**
 * Server clock, ticking. Captured once per list response: the serverNowMs
 * snapshot every row of that response carries, plus the local moment it
 * arrived; the displayed clock is the base advanced by local 1s ticks. Client
 * clock skew therefore only drifts the display — it can never fabricate an
 * earlier arrival, and the server stays the sole state authority. Ticks only
 * while marches are in flight.
 */
function useServerTickingClock(list: MarchListView | null | undefined): number | null {
  const clock = useMemo(
    () => ({ baseMs: list?.marches[0]?.serverNowMs ?? null, receivedAtMs: Date.now() }),
    [list],
  )
  const anyActive = (list?.activeCount ?? 0) > 0
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!anyActive) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyActive])
  if (clock.baseMs === null) return null
  return clock.baseMs + Math.max(0, nowMs - clock.receivedAtMs)
}

// ── March row ────────────────────────────────────────────────────────────────

interface MarchRowProps {
  march: MarchView
  serverNowMs: number | null
  cancelPending: boolean
  processPending: boolean
  withdrawPending: boolean
  onCancel: (march: MarchView) => void
  onProcess: (march: MarchView) => void
  onWithdraw: (march: MarchView) => void
}

function MarchRow({
  march,
  serverNowMs,
  cancelPending,
  processPending,
  withdrawPending,
  onCancel,
  onProcess,
  onWithdraw,
}: MarchRowProps) {
  const inFlight = march.status === 'EN_ROUTE' || march.status === 'RETURNING'
  const stationed = march.status === 'ARRIVED'
  const targetMs = countdownTargetMs(march)
  const remainingSec =
    targetMs !== null && serverNowMs !== null ? (targetMs - serverNowMs) / 1000 : null
  // The local estimate hitting zero is only a display hint — POST process is
  // an idempotent no-op unless the SERVER clock agrees the leg is due.
  const dueByEstimate = remainingSec !== null && remainingSec <= 0
  const showProcess = inFlight && (march.dueNow || dueByEstimate)
  const terminal =
    march.status === 'COMPLETED' || march.status === 'CANCELLED' || march.status === 'LOST'
  const survivors =
    march.survivors !== null && march.survivors.length > 0 ? stacksSummary(march.survivors) : null

  return (
    <li
      className={`rounded border px-2.5 py-2 ${
        terminal ? 'border-zinc-800/70 bg-zinc-950/40 opacity-75' : 'border-zinc-800 bg-zinc-950/60'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge
            variant="outline"
            className={`shrink-0 px-1.5 py-0 text-[9px] font-semibold ${
              MARCH_TYPE_BADGE[march.type] ?? 'border-zinc-700 text-zinc-400'
            }`}
          >
            <span aria-hidden className="mr-0.5">
              {MARCH_TYPE_GLYPH[march.type] ?? '•'}
            </span>
            {march.type}
          </Badge>
          <span className="min-w-0 truncate font-mono text-[10px] text-zinc-400">
            ({march.origin.x},{march.origin.y}) → {destinationText(march)}
            {march.destination.name ? (
              <span className="text-zinc-300"> {march.destination.name}</span>
            ) : null}
          </span>
        </span>
        <Badge
          variant="outline"
          className={`shrink-0 gap-1 px-1.5 py-0 text-[9px] ${MARCH_STATUS_BADGE[march.status]}`}
        >
          {march.status === 'EN_ROUTE' ? (
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"
            />
          ) : null}
          {march.status}
        </Badge>
        {stationed ? (
          <Badge
            variant="outline"
            className="shrink-0 gap-1 border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0 text-[9px] font-semibold text-cyan-300"
          >
            <span aria-hidden>🛡</span>
            STATIONED
          </Badge>
        ) : null}
      </div>

      <p className="mt-1 text-[10px] text-zinc-500 [overflow-wrap:anywhere]">
        {stacksSummary(march.units)}
      </p>

      {inFlight ? (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px]">
          {remainingSec === null ? null : remainingSec > 0 ? (
            <>
              <span className="font-mono font-semibold text-amber-300">
                {march.status === 'EN_ROUTE' ? 'arrives in' : 'home in'}{' '}
                {formatCountdown(remainingSec)}
              </span>
              <span className="text-zinc-600">· server-scheduled</span>
            </>
          ) : (
            <span className="font-semibold text-orange-300">due — awaiting server check</span>
          )}
          {survivors ? <span className="text-zinc-500">· survivors {survivors}</span> : null}
        </p>
      ) : march.status === 'RESOLVING' ? (
        <p className="mt-1 text-[10px] text-amber-200">resolving on the server…</p>
      ) : (
        <p className="mt-1 text-[10px] text-zinc-500 [overflow-wrap:anywhere]">
          {outcomeSummary(march) ?? march.status.toLowerCase()}
          {march.completedAt ? (
            <span className="text-zinc-600">
              {' '}
              · {new Date(march.completedAt).toLocaleTimeString()}
            </span>
          ) : null}
          {survivors ? <span> · survivors {survivors}</span> : null}
        </p>
      )}

      {march.cancellable || showProcess || stationed ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {march.cancellable ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] border-zinc-700 px-3 text-[10px] font-bold text-zinc-300 hover:bg-zinc-800"
              disabled={cancelPending}
              onClick={() => onCancel(march)}
              aria-label={`Recall the ${march.type} march to ${destinationText(march)}`}
            >
              {cancelPending ? '… RECALLING' : '[ RECALL ]'}
            </Button>
          ) : null}
          {showProcess ? (
            <Button
              size="sm"
              className="min-h-[44px] bg-amber-500 px-3 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
              disabled={processPending}
              onClick={() => onProcess(march)}
              aria-label={`Ask the server to check progress of the march to ${destinationText(march)}`}
            >
              {processPending ? '… CHECKING' : '[ CHECK PROGRESS ]'}
            </Button>
          ) : null}
          {stationed ? (
            <Button
              size="sm"
              className="min-h-[44px] border border-cyan-500/40 bg-cyan-500/10 px-3 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/20"
              disabled={withdrawPending}
              onClick={() => onWithdraw(march)}
              aria-label={`Withdraw the stationed detachment from ${destinationText(march)}`}
            >
              {withdrawPending ? '… WITHDRAWING' : '[ WITHDRAW ]'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Full-width console card. Owns its queries (enabled only while a session
 * exists) so page.tsx stays additive; anonymous users get the standard
 * sign-in prompt, exactly like the World Map section.
 */
export function MarchesSection({ signedIn }: { signedIn: boolean }) {
  const {
    data: list,
    error: listError,
    isPending: listPending,
    refetch: refetchList,
  } = useMarches({ enabled: signedIn })
  const cancel = useCancelMarch()
  const process = useProcessMarch()
  const withdraw = useWithdrawMarch()
  const { toast } = useToast()

  const serverNowMs = useServerTickingClock(list)

  function handleCancel(march: MarchView) {
    cancel.mutate(march.id, {
      onSuccess: (result) => {
        toast({
          title: `March recalled — ${result.unitsReleased} units released`,
          description:
            result.energyRefunded > 0
              ? `+${result.energyRefunded} energy refunded`
              : 'The reservation manifest returned to your army',
        })
      },
      onError: (error) => {
        const typed = error as Error & { code?: string }
        toast({
          title: 'Recall failed',
          description:
            (typed.code ? CANCEL_ERROR_TEXT[typed.code] : undefined) ??
            typed.message ??
            'Recall failed — try again',
          variant: 'destructive',
        })
      },
    })
  }

  function handleProcess(march: MarchView) {
    process.mutate(march.id, {
      onSuccess: (result) => {
        // Only the server's transition deserves a toast — a not-due call is a
        // silent no-op by design.
        if (result.processed) {
          toast({
            title: `March ${result.march.status.toLowerCase()}`,
            description: outcomeSummary(result.march) ?? 'The server advanced this march',
          })
        }
      },
      onError: (error) => {
        const typed = error as Error & { code?: string }
        toast({
          title: 'Progress check failed',
          description:
            (typed.code ? PROCESS_ERROR_TEXT[typed.code] : undefined) ??
            typed.message ??
            'Progress check failed — try again',
          variant: 'destructive',
        })
      },
    })
  }

  function handleWithdraw(march: MarchView) {
    withdraw.mutate(march.id, {
      onSuccess: (result) => {
        toast({
          title: `Withdrawal started — ${result.unitsReturning} units heading home`,
          description:
            'The detachment rides the march return leg and rejoins your army at homecoming.',
        })
      },
      onError: (error) => {
        const typed = error as Error & { code?: string }
        toast({
          title: 'Withdrawal refused',
          description:
            (typed.code ? WITHDRAW_ERROR_TEXT[typed.code] : undefined) ??
            typed.message ??
            'Withdrawal failed — try again',
          variant: 'destructive',
        })
      },
    })
  }

  const headerStatus = list
    ? list.activeCount > 0
      ? `${list.activeCount} ACTIVE`
      : 'IDLE'
    : signedIn
      ? 'NO MARCHES'
      : 'SIGN IN TO VIEW'

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
          Marches
          <span
            className={`inline-flex items-center gap-2 text-xs font-semibold ${
              list
                ? list.activeCount > 0
                  ? 'text-amber-400'
                  : 'text-emerald-400'
                : 'text-zinc-500'
            }`}
            aria-live="polite"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                list
                  ? list.activeCount > 0
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-emerald-400'
                  : 'bg-zinc-600'
              }`}
            />
            {headerStatus}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
        {list ? (
          <>
            {/* Capacity strip — live from the server list projection */}
            <p className="font-mono text-xs text-zinc-400">
              <span className="text-amber-400">{list.activeCount}</span> active ·{' '}
              <span className="text-amber-400">{list.activeCount}</span> /{' '}
              <span className="text-zinc-200">{list.slots}</span> slots
            </p>
            <Separator className="bg-zinc-800" />

            {list.marches.length === 0 ? (
              <p className="leading-relaxed text-zinc-500">
                No marches yet — select a territory on the world map and launch one from its detail
                panel.
              </p>
            ) : (
              <ul
                className="max-h-96 space-y-1.5 overflow-y-auto pr-1"
                aria-label="Your marches, newest first"
              >
                {list.marches.map((march) => (
                  <MarchRow
                    key={march.id}
                    march={march}
                    serverNowMs={serverNowMs}
                    cancelPending={cancel.isPending}
                    processPending={process.isPending}
                    withdrawPending={withdraw.isPending}
                    onCancel={handleCancel}
                    onProcess={handleProcess}
                    onWithdraw={handleWithdraw}
                  />
                ))}
              </ul>
            )}

            <Separator className="bg-zinc-800" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Server-authoritative marches: origin, distance, travel time, arrival, battle and
              homecoming are computed inside one globally serialized transaction. Countdowns are
              display-only — derived from the row&apos;s{' '}
              <span className="text-amber-400">serverNowMs</span> snapshot plus a local tick, so
              clock skew can shift the display but never the outcome; only the server advances a
              march, and <span className="text-amber-400">[ CHECK PROGRESS ]</span> merely asks it
              to look. Recalling releases the reserved units but never refunds mobilization energy.
            </p>
          </>
        ) : listPending && signedIn ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-1/3 bg-zinc-800" />
            <Skeleton className="h-14 w-full bg-zinc-800" />
            <Skeleton className="h-14 w-full bg-zinc-800" />
          </div>
        ) : listError ? (
          <div className="space-y-1.5">
            <p className="text-red-400" role="alert">
              {(listError as Error & { code?: string }).code ?? 'ERROR'}: {listError.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
              onClick={() => refetchList()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <p className="leading-relaxed text-zinc-500">
            {signedIn
              ? 'Signed in but no march projection available — reload to retry.'
              : 'Anonymous — sign in to launch marches, follow their progress live and recall fleets.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
