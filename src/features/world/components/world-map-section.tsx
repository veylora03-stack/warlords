'use client'

/**
 * WARLORDS — World Map & Territories section for the Mini App console.
 *
 * Renders the LIVE server viewport (GET /api/v1/world/map) as a CSS grid of
 * terrain-tinted cells with pan/recenter controls, a region strip and a lazy
 * territory detail panel (GET /api/v1/world/territories/[id]) with the
 * server-computed assault verdict, production collection and the append-only
 * ownership history. Every value shown is server-computed — nothing here is
 * mock, hard-coded or optimistic: adjacency, season gates, terrain, garrisons,
 * casualties, capture and production accrual are decided by the server.
 *
 * Visual language matches the console: zinc/dark surfaces, amber accents,
 * text-[11px] uppercase tracking-wider labels, mono body text. The grid sizes
 * itself into its container (minmax(0,1fr) + aspect-square cells) — no
 * horizontal overflow at 390px.
 */

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import {
  useAttackTerritory,
  useCollectProduction,
  usePlayerTerritories,
  useTerritoryDetail,
  useTerritoryHistory,
  useWorldMap,
} from '../api/world'
import type {
  AttackBlockerReason,
  BattleOutcome,
  TerritoryAttackResult,
  TerritoryHistoryReason,
  TerritoryMapCell,
  WorldBounds,
  WorldSize,
} from '../types'

// ── Static class lookups (never interpolate Tailwind class names) ────────────

/** terrainColor family → cell appearance + accent text (config/world.ts). */
const TERRAIN_CELL_CLASSES: Record<string, { cell: string; text: string }> = {
  lime: { cell: 'border-lime-800/50 bg-lime-900/40 hover:bg-lime-800/60', text: 'text-lime-300' },
  emerald: {
    cell: 'border-emerald-800/50 bg-emerald-900/40 hover:bg-emerald-800/60',
    text: 'text-emerald-300',
  },
  zinc: { cell: 'border-zinc-700/60 bg-zinc-800/50 hover:bg-zinc-700/60', text: 'text-zinc-300' },
  amber: {
    cell: 'border-amber-800/50 bg-amber-900/40 hover:bg-amber-800/60',
    text: 'text-amber-300',
  },
  teal: { cell: 'border-teal-800/50 bg-teal-900/40 hover:bg-teal-800/60', text: 'text-teal-300' },
  yellow: {
    cell: 'border-yellow-800/50 bg-yellow-900/40 hover:bg-yellow-800/60',
    text: 'text-yellow-300',
  },
  sky: { cell: 'border-sky-800/50 bg-sky-900/40 hover:bg-sky-800/60', text: 'text-sky-300' },
  cyan: { cell: 'border-cyan-800/50 bg-cyan-900/40 hover:bg-cyan-800/60', text: 'text-cyan-300' },
  orange: {
    cell: 'border-orange-800/50 bg-orange-900/40 hover:bg-orange-800/60',
    text: 'text-orange-300',
  },
}

const FALLBACK_TERRAIN = TERRAIN_CELL_CLASSES.zinc ?? null

/** Server attackability reason → human text (exact server vocabulary). */
const ATTACK_REASON_TEXT: Record<AttackBlockerReason, string> = {
  NOT_ADJACENT: 'Requires an adjacent territory (N/S/E/W)',
  CAPITAL_PROTECTED: 'Capitals cannot be attacked',
  OWNED_BY_YOU: 'You already control this territory',
  LOCKED: 'This site is sealed',
  ACTION_ON_COOLDOWN: 'Army regrouping',
  INSUFFICIENT_ENERGY: 'Not enough energy',
  ARMY_EMPTY: 'No units available',
  SEASON_NOT_ACTIVE: 'No active season',
}

/** Typed assault refusal → human text (server error codes win). */
const ATTACK_ERROR_TEXT: Record<string, string> = {
  TERRITORY_NOT_FOUND: 'Territory not found',
  TERRITORY_OWNED: 'You already control this territory',
  TERRITORY_CAPITAL_PROTECTED: 'Capitals cannot be attacked',
  TERRITORY_LOCKED: 'This site is sealed',
  TERRITORY_NOT_ADJACENT: 'Requires an adjacent territory (N/S/E/W)',
  SEASON_NOT_ACTIVE: 'No active season',
  ACTION_ON_COOLDOWN: 'Army regrouping — wait out the attack cooldown',
  INSUFFICIENT_ENERGY: 'Not enough energy to assault',
  ARMY_EMPTY: 'Train units before attacking',
  IDEMPOTENT_REPLAY: 'This order was already processed',
  VALIDATION_ERROR: 'Invalid attack request',
}

const COLLECT_ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: 'You do not control this territory',
  TERRITORY_NOT_COLLECTIBLE: 'Production is not ready yet',
}

const HISTORY_REASON_TEXT: Record<TerritoryHistoryReason, string> = {
  CAPTURE: 'Captured',
  SEASON_RESET: 'Season reset',
  ADMIN: 'Admin action',
  SPAWN: 'Founded',
}

const OUTCOME_LABEL: Record<BattleOutcome, string> = {
  VICTORY: 'Victory',
  DEFEAT: 'Defeat',
  DRAW: 'Draw',
}

const STATUS_LABEL: Record<string, string> = {
  UNCLAIMED: 'UNCLAIMED',
  CONTROLLED: 'CONTROLLED',
  LOCKED: 'SEALED',
}

// ── Viewport helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Shifts a viewport by whole cells, clamped inside the world grid. */
function shiftBounds(bounds: WorldBounds, size: WorldSize, dx: number, dy: number): WorldBounds {
  const width = bounds.maxX - bounds.minX + 1
  const height = bounds.maxY - bounds.minY + 1
  const minX = clamp(bounds.minX + dx, 0, Math.max(0, size.sizeX - width))
  const minY = clamp(bounds.minY + dy, 0, Math.max(0, size.sizeY - height))
  return { minX, maxX: minX + width - 1, minY, maxY: minY + height - 1 }
}

/** Pan stride — half a viewport keeps the current view anchored on-screen. */
function panStride(bounds: WorldBounds): number {
  return Math.max(1, Math.floor((bounds.maxX - bounds.minX + 1) / 2))
}

function territoryLabel(cell: TerritoryMapCell): string {
  return cell.name ? `territory ${cell.x},${cell.y} ${cell.name}` : `territory ${cell.x},${cell.y}`
}

/** "+250 GOLD · +30 WOOD" — spoils summary for toasts (server amounts only). */
function spoilsSummary(spoils: Record<string, string>): string {
  return Object.entries(spoils)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([key, amount]) => `+${amount} ${key}`)
    .join(' · ')
}

function attackErrorText(error: Error & { code?: string }): string {
  if (error.code && ATTACK_ERROR_TEXT[error.code]) return ATTACK_ERROR_TEXT[error.code]
  return error.message || 'Assault failed — try again'
}

// ── Map grid ──────────────────────────────────────────────────────────────────

interface MapGridProps {
  bounds: WorldBounds
  cellById: Map<string, TerritoryMapCell>
  ownedIds: Set<string>
  selectedId: string | null
  onSelect: (territoryId: string) => void
}

function MapGrid({ bounds, cellById, ownedIds, selectedId, onSelect }: MapGridProps) {
  const columns = bounds.maxX - bounds.minX + 1
  const cells: Array<TerritoryMapCell | null> = []
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      cells.push(cellById.get(`${x},${y}`) ?? null)
    }
  }

  return (
    <div
      className="mx-auto grid w-full max-w-[320px] gap-[2px]"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      aria-label="World map grid"
    >
      {cells.map((cell, index) => {
        if (!cell) {
          // Hole in the payload — never a fake button, just dead space.
          return <div key={`gap-${index}`} className="aspect-square rounded-[2px] bg-zinc-950" />
        }
        const terrain = TERRAIN_CELL_CLASSES[cell.terrainColor] ?? FALLBACK_TERRAIN
        const locked = cell.status === 'LOCKED'
        const owned = ownedIds.has(cell.id)
        const selected = cell.id === selectedId
        const className = [
          'relative flex aspect-square items-center justify-center rounded-[2px] border text-[9px] font-bold leading-none',
          terrain?.cell ?? 'border-zinc-700/60 bg-zinc-800/50',
          locked ? 'opacity-40' : '',
          owned ? 'border-amber-400/80 ring-1 ring-amber-400/40' : '',
          selected ? 'z-10 ring-2 ring-amber-300 ring-offset-1 ring-offset-zinc-950' : '',
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <button
            key={cell.id}
            type="button"
            aria-label={territoryLabel(cell)}
            aria-pressed={selected}
            onClick={() => onSelect(cell.id)}
            className={className}
          >
            {locked ? (
              <span aria-hidden className="text-zinc-400">
                ✕
              </span>
            ) : cell.isCapital ? (
              <span aria-hidden className="text-amber-300">
                ★
              </span>
            ) : owned ? (
              <span aria-hidden className="text-amber-200/80">
                ·
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Full-width console card. Owns its queries (enabled only while a session
 * exists) so page.tsx stays additive; anonymous users get the standard
 * sign-in prompt, exactly like the Quests section.
 */
export function WorldMapSection({ signedIn }: { signedIn: boolean }) {
  // `null` viewport = server-picked (capital-centered) — the ⊙ button returns here.
  const [requestedBounds, setRequestedBounds] = useState<WorldBounds | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const [lastAttack, setLastAttack] = useState<TerritoryAttackResult | null>(null)

  const {
    data: map,
    error: mapError,
    isPending: mapPending,
    refetch: refetchMap,
  } = useWorldMap({ enabled: signedIn, bounds: requestedBounds })
  const { data: holdings } = usePlayerTerritories({ enabled: signedIn })
  const {
    data: detail,
    error: detailError,
    isPending: detailPending,
    refetch: refetchDetail,
  } = useTerritoryDetail({ enabled: signedIn, territoryId: selectedId })
  const {
    data: history,
    error: historyError,
    isPending: historyPending,
    refetch: refetchHistory,
  } = useTerritoryHistory({
    enabled: signedIn && historyOpen,
    territoryId: selectedId,
    page: historyPage,
  })

  const attack = useAttackTerritory()
  const collect = useCollectProduction()
  const { toast } = useToast()

  const ownedIds = useMemo(
    () => new Set((holdings?.territories ?? []).map((row) => row.id)),
    [holdings],
  )
  const pendingTotal = useMemo(
    () => (holdings?.territories ?? []).reduce((sum, row) => sum + row.pendingAmount, 0),
    [holdings],
  )
  const cellById = useMemo(() => {
    const index = new Map<string, TerritoryMapCell>()
    for (const cell of map?.territories ?? []) index.set(`${cell.x},${cell.y}`, cell)
    return index
  }, [map])
  const collectibleCount = useMemo(
    () => (holdings?.territories ?? []).filter((row) => row.collectible).length,
    [holdings],
  )

  const bounds = map?.bounds ?? null
  const worldSize = map?.worldSize ?? null

  function pan(dx: number, dy: number) {
    if (!map) return
    const base = requestedBounds ?? map.bounds
    setRequestedBounds(shiftBounds(base, map.worldSize, dx, dy))
  }

  function handleSelect(territoryId: string) {
    // Second tap on the selected cell deselects; switching cells resets the
    // history pane (it reloads per territory anyway).
    if (territoryId === selectedId) {
      setSelectedId(null)
      setHistoryOpen(false)
      setLastAttack(null)
      return
    }
    setSelectedId(territoryId)
    setHistoryOpen(false)
    setHistoryPage(1)
    setLastAttack(null)
  }

  function handleAttack() {
    if (!selectedId) return
    const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())
    attack.mutate(
      { territoryId: selectedId, idempotencyKey: key },
      {
        onSuccess: (result) => {
          setLastAttack(result)
          const spoils = spoilsSummary(result.spoils)
          const captured = result.territory.captured ? ' · territory captured' : ''
          toast({
            title: `${OUTCOME_LABEL[result.outcome]}${spoils ? ` — ${spoils}` : ''}${captured}`,
            description: `Casualties — attacker ${result.casualties.attacker.length} lines · defender ${
              result.casualties.defender.length
            } · ${result.roundsCount} rounds${result.replayed ? ' · replay' : ''}`,
          })
        },
        onError: (error) => {
          toast({
            title: 'Assault failed',
            description: attackErrorText(error as Error & { code?: string }),
            variant: 'destructive',
          })
        },
      },
    )
  }

  function handleCollect() {
    if (!selectedId) return
    collect.mutate(selectedId, {
      onSuccess: (result) => {
        toast({
          title: `Collected +${result.amount} ${result.resourceType}`,
          description: 'Credited through the ledger (TERRITORY_PRODUCTION)',
        })
      },
      onError: (error) => {
        const typed = error as Error & { code?: string }
        toast({
          title: 'Collection failed',
          description:
            (typed.code ? COLLECT_ERROR_TEXT[typed.code] : undefined) ??
            typed.message ??
            'Collection failed — try again',
          variant: 'destructive',
        })
      },
    })
  }

  const headerStatus = map
    ? collectibleCount > 0
      ? `${collectibleCount} READY`
      : `${holdings?.total ?? 0} HELD`
    : signedIn
      ? 'NO WORLD'
      : 'SIGN IN TO VIEW'

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
          World Map
          <span
            className={`inline-flex items-center gap-2 text-xs font-semibold ${
              map ? (collectibleCount > 0 ? 'text-amber-400' : 'text-emerald-400') : 'text-zinc-500'
            }`}
            aria-live="polite"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                map
                  ? collectibleCount > 0
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
        {map && bounds && worldSize ? (
          <>
            {/* Holdings line — server-computed ownership summary */}
            <p className="font-mono text-xs text-zinc-400">
              {holdings?.capital ? (
                <>
                  Capital at ({holdings.capital.x},{holdings.capital.y}) ·{' '}
                </>
              ) : null}
              <span className="text-amber-400">{holdings?.total ?? 0}</span> territories
              {pendingTotal > 0 ? (
                <>
                  {' '}
                  · <span className="text-amber-400">{pendingTotal}</span> pending production
                </>
              ) : null}
            </p>
            <Separator className="bg-zinc-800" />

            {/* Pan controls — half-viewport strides, clamped server-side too */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1.5" role="group" aria-label="Map pan controls">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 w-11 border-zinc-700 p-0 font-mono text-sm text-zinc-300 hover:bg-zinc-800"
                  aria-label="Pan west"
                  disabled={bounds.minX === 0}
                  onClick={() => pan(-panStride(bounds), 0)}
                >
                  ←
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 w-11 border-zinc-700 p-0 font-mono text-sm text-zinc-300 hover:bg-zinc-800"
                  aria-label="Pan north"
                  disabled={bounds.minY === 0}
                  onClick={() => pan(0, -panStride(bounds))}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 w-11 border-zinc-700 p-0 font-mono text-sm text-zinc-300 hover:bg-zinc-800"
                  aria-label="Pan south"
                  disabled={bounds.maxY >= worldSize.sizeY - 1}
                  onClick={() => pan(0, panStride(bounds))}
                >
                  ↓
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 w-11 border-zinc-700 p-0 font-mono text-sm text-zinc-300 hover:bg-zinc-800"
                  aria-label="Pan east"
                  disabled={bounds.maxX >= worldSize.sizeX - 1}
                  onClick={() => pan(panStride(bounds), 0)}
                >
                  →
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-11 border-zinc-700 px-3 font-mono text-xs text-amber-300 hover:bg-zinc-800"
                aria-label="Recenter map on your capital"
                onClick={() => setRequestedBounds(null)}
              >
                ⊙ recenter
              </Button>
            </div>
            <p className="text-[10px] text-zinc-500">
              viewport x {bounds.minX}–{bounds.maxX} · y {bounds.minY}–{bounds.maxY} · {map.total}{' '}
              cells · world {worldSize.sizeX}×{worldSize.sizeY}
            </p>

            {/* Region strip — regions intersecting the current viewport */}
            {map.regions.length > 0 ? (
              <div className="flex flex-wrap gap-1" aria-label="Regions in view">
                {map.regions.map((region) => (
                  <Badge
                    key={region.id}
                    variant="outline"
                    className="border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-400"
                  >
                    {region.name}
                  </Badge>
                ))}
              </div>
            ) : null}

            <MapGrid
              bounds={bounds}
              cellById={cellById}
              ownedIds={ownedIds}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
            <p className="text-[10px] text-zinc-500">
              ★ capital · ✕ sealed site · <span className="text-amber-400">amber outline</span> =
              your territory · tap a cell to inspect
            </p>

            <Separator className="bg-zinc-800" />

            {/* Detail panel — lazy-loads only for the selected cell */}
            <section aria-label="Territory detail" className="space-y-2">
              {!selectedId ? (
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Select a territory to inspect it — terrain, ownership, garrison strength and the
                  server&apos;s assault verdict.
                </p>
              ) : detailPending ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-2/3 bg-zinc-800" />
                  <Skeleton className="h-3 w-1/2 bg-zinc-800" />
                  <Skeleton className="h-11 w-full bg-zinc-800" />
                </div>
              ) : detailError ? (
                <div className="space-y-1.5">
                  <p className="text-red-400" role="alert">
                    {(detailError as Error & { code?: string }).code ?? 'ERROR'}:{' '}
                    {detailError.message}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
                    onClick={() => refetchDetail()}
                  >
                    Retry
                  </Button>
                </div>
              ) : detail ? (
                <>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate font-semibold text-zinc-200">
                        {detail.name ?? 'Unnamed site'}
                      </span>
                      {detail.isCapital ? (
                        <Badge className="shrink-0 border border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[9px] text-amber-300">
                          CAPITAL
                        </Badge>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                      ({detail.x},{detail.y})
                    </span>
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className={`border-zinc-700 px-1.5 py-0 text-[9px] ${
                        (TERRAIN_CELL_CLASSES[detail.terrainColor] ?? FALLBACK_TERRAIN)?.text ??
                        'text-zinc-300'
                      }`}
                    >
                      {detail.terrainLabel}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`px-1.5 py-0 text-[9px] ${
                        detail.status === 'LOCKED'
                          ? 'border-zinc-700 text-zinc-500'
                          : detail.status === 'CONTROLLED'
                            ? 'border-amber-500/30 text-amber-300'
                            : 'border-zinc-700 text-zinc-400'
                      }`}
                    >
                      {STATUS_LABEL[detail.status] ?? detail.status}
                    </Badge>
                    {detail.region ? (
                      <Badge
                        variant="outline"
                        className="border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-400"
                      >
                        {detail.region.name}
                      </Badge>
                    ) : null}
                    <span className="text-[10px] text-zinc-500">
                      {detail.ownerName
                        ? `Held by ${detail.ownerName}`
                        : `Unclaimed — garrison strength ${detail.defenseStrength}`}
                    </span>
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
                    {detail.resourceType ? (
                      <span>
                        produces{' '}
                        <span className="text-amber-400">
                          +{detail.productionRate}/h {detail.resourceType}
                        </span>
                      </span>
                    ) : (
                      <span>no production</span>
                    )}
                    <span>
                      strategic value <span className="text-zinc-300">{detail.strategicValue}</span>
                    </span>
                    <span>
                      captured <span className="text-zinc-300">{detail.captureCount}</span>×
                    </span>
                  </div>

                  {/* Assault block — the server's verdict is the whole story */}
                  <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
                    {detail.attack.attackable ? (
                      <Button
                        size="sm"
                        className="min-h-[44px] w-full bg-amber-500 text-[11px] font-bold text-zinc-950 hover:bg-amber-400"
                        disabled={attack.isPending}
                        onClick={handleAttack}
                        aria-label={`Assault ${territoryLabel(detail)}`}
                      >
                        {attack.isPending ? '… ASSAULTING' : '[ ASSAULT ]'}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-[44px] w-full border-zinc-700 text-[11px] font-bold text-zinc-500"
                          disabled
                          aria-label={`Assault unavailable for ${territoryLabel(detail)}`}
                        >
                          [ ASSAULT ]
                        </Button>
                        <ul className="space-y-0.5">
                          {detail.attack.reasons.map((reason) => (
                            <li
                              key={reason}
                              className="flex items-center gap-1 text-[10px] text-orange-400"
                            >
                              <span aria-hidden>🔒</span>
                              <span className="min-w-0">
                                {ATTACK_REASON_TEXT[reason] ?? reason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>

                  {/* Production collection — owner-only, server-gated */}
                  {detail.production ? (
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
                      <span className="min-w-0 text-[10px] text-zinc-400">
                        <span className="text-amber-400">
                          {detail.production.pendingAmount} {detail.resourceType}
                        </span>{' '}
                        pending
                      </span>
                      {detail.production.collectible ? (
                        <Button
                          size="sm"
                          className="min-h-[44px] bg-amber-500 px-3 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
                          disabled={collect.isPending}
                          onClick={handleCollect}
                          aria-label={`Collect production from ${territoryLabel(detail)}`}
                        >
                          {collect.isPending ? '… COLLECTING' : '[ COLLECT ]'}
                        </Button>
                      ) : (
                        <span className="shrink-0 text-[10px] text-zinc-500">
                          Next collection{' '}
                          {detail.production.nextCollectAtMs
                            ? new Date(detail.production.nextCollectAtMs).toLocaleTimeString()
                            : '—'}
                        </span>
                      )}
                    </div>
                  ) : null}

                  {/* Last assault result — server report only, per selection */}
                  {lastAttack && lastAttack.territory.id === selectedId ? (
                    <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
                      <p className="text-[10px] font-semibold text-amber-300">
                        {OUTCOME_LABEL[lastAttack.outcome]} ·{' '}
                        {lastAttack.territory.captured ? 'CAPTURED' : 'DEFENSE HELD'}
                        {lastAttack.replayed ? ' · REPLAY' : ''}
                      </p>
                      <p className="text-[10px] text-zinc-400">
                        {spoilsSummary(lastAttack.spoils) || 'no spoils'} · honor{' '}
                        {lastAttack.honor.attackerDelta >= 0 ? '+' : ''}
                        {lastAttack.honor.attackerDelta} · {lastAttack.seasonPointsAwarded} season
                        pts
                      </p>
                      <p className="text-[10px] text-zinc-500">
                        Casualties — attacker {lastAttack.casualties.attacker.length} lines ·
                        defender {lastAttack.casualties.defender.length} lines ·{' '}
                        {lastAttack.roundsCount} rounds
                      </p>
                    </div>
                  ) : null}

                  {/* Ownership history — append-only public world record */}
                  <Collapsible
                    open={historyOpen}
                    onOpenChange={(open) => {
                      setHistoryOpen(open)
                      if (open) setHistoryPage(1)
                    }}
                  >
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 border-zinc-700 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 hover:bg-zinc-800"
                        aria-expanded={historyOpen}
                      >
                        {historyOpen ? '▾' : '▸'} ownership history
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-2">
                      {historyPending ? (
                        <div className="space-y-1.5">
                          <Skeleton className="h-3 w-3/4 bg-zinc-800" />
                          <Skeleton className="h-3 w-2/3 bg-zinc-800" />
                        </div>
                      ) : historyError ? (
                        <div className="space-y-1.5">
                          <p className="text-red-400" role="alert">
                            {(historyError as Error & { code?: string }).code ?? 'ERROR'}:{' '}
                            {historyError.message}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 border-zinc-700 px-2 text-[10px] text-zinc-300"
                            onClick={() => refetchHistory()}
                          >
                            Retry
                          </Button>
                        </div>
                      ) : history && history.rows.length > 0 ? (
                        <div className="space-y-1.5">
                          <ul className="space-y-1">
                            {history.rows.map((row) => (
                              <li
                                key={row.id}
                                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]"
                              >
                                <Badge
                                  variant="outline"
                                  className="shrink-0 border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-400"
                                >
                                  {HISTORY_REASON_TEXT[row.reason] ?? row.reason}
                                </Badge>
                                <span className="min-w-0 truncate text-zinc-400">
                                  {row.previousOwner.name ?? 'unclaimed'} →{' '}
                                  <span className="text-zinc-200">
                                    {row.newOwner.name ?? 'unclaimed'}
                                  </span>
                                </span>
                                <span className="shrink-0 text-zinc-600">
                                  {row.createdAt.slice(0, 10)} · s{row.seasonNumber}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {history.pages > 1 ? (
                            <div className="flex items-center justify-between gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 border-zinc-700 px-2 text-[10px] text-zinc-300"
                                disabled={historyPage <= 1}
                                aria-label="Previous history page"
                                onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
                              >
                                ‹ prev
                              </Button>
                              <span className="text-[10px] text-zinc-500">
                                page {history.page}/{history.pages} · {history.total} records
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 border-zinc-700 px-2 text-[10px] text-zinc-300"
                                disabled={historyPage >= history.pages}
                                aria-label="Next history page"
                                onClick={() =>
                                  setHistoryPage((page) => Math.min(history.pages, page + 1))
                                }
                              >
                                next ›
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-[10px] leading-relaxed text-zinc-500">
                          No recorded ownership changes — this cell has never changed hands.
                        </p>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                </>
              ) : null}
            </section>

            <Separator className="bg-zinc-800" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Server-authoritative world: adjacency, season gates, terrain modifiers, garrisons and
              capture are computed inside one globally serialized transaction — the client cannot
              influence any of it. Capture lands ONLY on an attacker win and is written to the
              append-only ownership history; production accrues lazily and enters the economy
              through the ledger (<span className="text-amber-400">TERRITORY_PRODUCTION</span>).
            </p>
          </>
        ) : mapPending && signedIn ? (
          <div className="space-y-3">
            <Skeleton className="h-3 w-1/2 bg-zinc-800" />
            <Skeleton className="mx-auto aspect-square w-full max-w-[320px] bg-zinc-800" />
            <Skeleton className="h-3 w-2/3 bg-zinc-800" />
          </div>
        ) : mapError ? (
          <div className="space-y-1.5">
            <p className="text-red-400" role="alert">
              {(mapError as Error & { code?: string }).code ?? 'ERROR'}: {mapError.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
              onClick={() => refetchMap()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <p className="leading-relaxed text-zinc-500">
            {signedIn
              ? 'Signed in but the world map is unavailable — reload to retry.'
              : 'Anonymous — sign in to scout the world map, assault territories and collect production.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
