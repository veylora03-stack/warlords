'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useHealthQuery } from '@/features/system'
import { useMeQuery } from '@/features/auth'
import { AdminPanel } from '@/features/admin'
import { NotificationBell } from '@/features/notifications'
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
import {
  BUILDING_ICONS,
  useCityQuery,
  useFinishBuildingMutation,
  useUpgradeBuildingMutation,
  type CityBuildingView,
} from '@/features/city'
import {
  UNIT_CLASS_ICONS,
  UNIT_CLASS_LABELS,
  useArmyCatalogQuery,
  useArmyQuery,
  useCancelTrainingMutation,
  useCompleteTrainingMutation,
  useRecruitMutation,
  type CatalogUnitView,
  type TrainingQueueItemView,
} from '@/features/army'
import {
  useClaimSeasonRewardMutation,
  useEquipTitleMutation,
  useSeasonProgressionQuery,
  useSeasonQuery,
  useSeasonRankingQuery,
  useSeasonRewardsQuery,
  type RankedRow,
  type SeasonRewardPayout,
} from '@/features/season'
import { useUiStore } from '@/stores/ui.store'
import {
  useAttackMutation,
  useBattleHistoryQuery,
  useBattleTargetsQuery,
  useBattleDetailQuery,
  type AttackResultView,
  type AttackTargetRow,
} from '@/features/battle'
import { QuestsSection } from '@/features/quests'
import { MarchesSection } from '@/features/marches'
import { WorldMapSection } from '@/features/world'

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
  {
    id: '06',
    name: 'City & Building System (17 buildings · server-side upgrades · construction timers)',
    state: 'done',
  },
  {
    id: '07',
    name: 'Army & Unit System (11 units · data-driven counters · recruitment queue)',
    state: 'done',
  },
  {
    id: '20',
    name: 'Seasonal System (season lifecycle · ranking · transactional reset · permanent progression)',
    state: 'done',
  },
  {
    id: '21',
    name: 'Admin Panel (RBAC admin/moderator · player ops · inspections · announcements · audit trail)',
    state: 'done',
  },
  {
    id: '22',
    name: 'Notification System (queueable engine · dedupe · worker · Telegram-ready channels)',
    state: 'done',
  },
  {
    id: '23',
    name: 'Security Audit (staff-ban rail · economy CAS · claim-guarded delivery · rate limits · headers)',
    state: 'done',
  },
  {
    id: '24',
    name: 'Full QA & Testing (537 tests · negative matrix · season rewards · full-journey E2E)',
    state: 'done',
  },
  {
    id: '25',
    name: 'Performance & Scalability (write-engine isolation · WAL · state 17→7 queries · memoized catalogs)',
    state: 'done',
  },
  {
    id: '26',
    name: 'Production Deployment (Docker · health probes · Telegram webhook + commands · PG baseline migrations · deploy guide)',
    state: 'done',
  },
  {
    id: '27',
    name: 'Final Production QA (589 tests · release journey E2E · live browser verification · honest release report)',
    state: 'done',
  },
  {
    id: '28',
    name: 'Battle Engine (deterministic sim · attack → combat → casualties → rewards → ranking → notifications → history)',
    state: 'done',
  },
  { id: '—', name: 'Territory, Quests & World', state: 'planned' },
  {
    id: '—',
    name: 'Telegram Bot full surface (referrals · quests · clan · settings)',
    state: 'planned',
  },
  { id: '—', name: 'Mini App UI (full client)', state: 'planned' },
  {
    id: '—',
    name: 'Ops Hardening (alerting · multi-region · backup automation)',
    state: 'planned',
  },
]

const DELIVERABLES = [
  {
    label:
      'Deterministic seeded simulator — same (seed, config, armies) ⇒ identical outcome; replayable, auditable, DB-mutation-free pure engine',
    file: 'src/lib/game/engine/battle/simulator.ts',
  },
  {
    label:
      'Full attack pipeline — validate → lock → energy CAS → simulate → casualties → ledger loot → honor/XP/season → stats → power → logs → notifications, ONE transaction',
    file: 'src/lib/game/services/battle.service.ts',
  },
  {
    label:
      'Data-driven balance — versioned config snapshotted onto every battle; counters from the unit catalog (2500 bps edges); wall/hospital extension points',
    file: 'src/lib/game/config/battle.ts',
  },
  {
    label:
      'Security matrix — self/nonexistent/protected targets, cooldown, energy, idempotency replay, concurrent double-submit, negative-unit invariants (integration + unit + E2E)',
    file: 'tests/integration/battle/battle-system.test.ts',
  },
  {
    label:
      'Mini App attack flow — target roster (armies hidden) → confirmation (cost/cooldown/risk) → result (VICTORY/DEFEAT) → history → round-by-round detail',
    file: 'src/features/battle · src/app/page.tsx',
  },
  {
    label:
      'Complete journey verified — ATTACK → COMBAT → CASUALTIES → REWARDS → RANKING → NOTIFICATION → HISTORY (E2E, real DB state)',
    file: 'docs/BATTLE-ENGINE.md',
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

/** Compact human strings for a building's effect map (display only). */
function formatEffects(effects: Record<string, unknown>): string {
  const parts: string[] = []
  const production = effects['productionPerHour'] as Record<string, number> | undefined
  if (production) {
    for (const [resource, rate] of Object.entries(production)) {
      parts.push(`${SHORT_CODE[resource] ?? resource} ${rate.toLocaleString('en-US')}/h`)
    }
  }
  const storage = effects['storageCapacity']
  if (typeof storage === 'number') parts.push(`cap ${storage.toLocaleString('en-US')}`)
  const defense = effects['defenseBps']
  if (typeof defense === 'number') parts.push(`def +${Math.round(defense - 10_000) / 100}%`)
  const queue = effects['queueSlots']
  if (typeof queue === 'number') parts.push(`queue ×${queue}`)
  const bpsLabels: Array<[string, string]> = [
    ['trainingSpeedBps', 'train'],
    ['researchSpeedBps', 'research'],
    ['equipmentSpeedBps', 'equip'],
    ['scoutSpeedBps', 'scout'],
    ['spyPowerBps', 'spy'],
  ]
  for (const [key, label] of bpsLabels) {
    const value = effects[key]
    if (typeof value === 'number' && value !== 10_000) {
      parts.push(`${label} +${Math.round(value - 10_000) / 100}%`)
    }
  }
  const hospital = effects['hospitalCapacity']
  if (typeof hospital === 'number') parts.push(`beds ${hospital}`)
  const march = effects['marchSlots']
  if (typeof march === 'number') parts.push(`marches ×${march}`)
  const fee = effects['marketFeeBps']
  if (typeof fee === 'number') parts.push(`fee ${fee / 100}%`)
  return parts.join(' · ')
}

function formatCountdown(completesAtIso: string, nowMs: number): string {
  const remainingSec = Math.max(0, Math.ceil((Date.parse(completesAtIso) - nowMs) / 1000))
  const mm = Math.floor(remainingSec / 60)
  const ss = remainingSec % 60
  return mm > 0 ? `${mm}m ${String(ss).padStart(2, '0')}s` : `${ss}s`
}

function formatCost(cost: Partial<Record<string, string>>): string {
  return Object.entries(cost)
    .map(
      ([resource, amount]) => `${SHORT_CODE[resource] ?? resource} ${formatAmount(amount ?? '0')}`,
    )
    .join(' ')
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

interface CityBuildingRowProps {
  building: CityBuildingView
  nowTick: number
  disabled: boolean
  onUpgrade: () => void
  onFinish: () => void
}

/** One building row: level, live construction state, next-upgrade preview + actions. */
function CityBuildingRow({
  building,
  nowTick,
  disabled,
  onUpgrade,
  onFinish,
}: CityBuildingRowProps) {
  const next = building.nextUpgrade
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          <span aria-hidden>{BUILDING_ICONS[building.type] ?? '🏗️'}</span>{' '}
          <span className="font-semibold text-zinc-200">{building.name}</span>{' '}
          <span className="text-zinc-500">
            lv{building.level}/{building.maxLevel}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {building.status === 'CONSTRUCTING' ? (
            <Badge className="bg-amber-500/15 border border-amber-500/40 px-1.5 py-0 text-[10px] text-amber-300">
              → lv{building.pendingLevel} · {formatCountdown(building.upgradeCompletesAt!, nowTick)}
            </Badge>
          ) : building.status === 'COMPLETABLE' ? (
            <Badge className="bg-emerald-500/15 border border-emerald-500/40 px-1.5 py-0 text-[10px] text-emerald-300">
              READY lv{building.pendingLevel}
            </Badge>
          ) : (
            <span className="text-[10px] text-zinc-600">idle</span>
          )}
          {building.status === 'COMPLETABLE' ? (
            <Button
              size="sm"
              className="h-7 bg-emerald-600 px-2 text-[10px] font-bold text-zinc-950 hover:bg-emerald-500"
              disabled={disabled}
              onClick={onFinish}
            >
              FINISH
            </Button>
          ) : building.nextUpgrade ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-bold text-amber-400 hover:bg-amber-500/20"
              disabled={disabled || !building.nextUpgrade.requirementsMet}
              onClick={onUpgrade}
              aria-label={`Upgrade ${building.name} to level ${building.nextUpgrade.toLevel}`}
            >
              UPGRADE
            </Button>
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-[10px] text-zinc-500">
          {formatEffects(building.effects) || '—'}
        </span>
        {building.status === 'IDLE' && next ? (
          <span className="min-w-0 text-right text-[10px] [overflow-wrap:anywhere]">
            <span className="text-zinc-500">→ lv{next.toLevel}: </span>
            <span className="text-zinc-400">{formatCost(next.cost)}</span>
            <span className="text-zinc-600"> · {next.durationSec}s · </span>
            {next.requirementsMet ? (
              <span className="text-emerald-400">ready</span>
            ) : (
              <span className="text-orange-400">{next.unmetRequirements[0] ?? 'locked'}</span>
            )}
          </span>
        ) : null}
      </div>
    </div>
  )
}

interface ArmyQueueRowProps {
  item: TrainingQueueItemView
  position: number
  nowTick: number
  disabled: boolean
  onComplete: () => void
  onCancel: () => void
}

/** One recruitment queue row: FIFO position, live countdown, claim/cancel actions. */
function ArmyQueueRow({
  item,
  position,
  nowTick,
  disabled,
  onComplete,
  onCancel,
}: ArmyQueueRowProps) {
  const ready = item.status === 'COMPLETABLE'
  const countdown =
    item.status === 'TRAINING' && Date.parse(item.completesAt) > nowTick
      ? formatCountdown(item.completesAt, nowTick)
      : item.status === 'TRAINING'
        ? formatCountdown(item.completesAt, nowTick) // clamped to 0s by the formatter
        : null
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          <span className="text-zinc-600">#{position}</span>{' '}
          <span className="font-semibold text-zinc-200">
            {item.count}× {item.unitName}
          </span>{' '}
          <span className="text-zinc-600">batch</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {ready ? (
            <Badge className="bg-emerald-500/15 border border-emerald-500/40 px-1.5 py-0 text-[10px] text-emerald-300">
              READY
            </Badge>
          ) : (
            <Badge className="bg-amber-500/15 border border-amber-500/40 px-1.5 py-0 text-[10px] text-amber-300">
              ⏳ {countdown ?? '…'}
            </Badge>
          )}
          {ready ? (
            <Button
              size="sm"
              className="h-7 bg-emerald-600 px-2 text-[10px] font-bold text-zinc-950 hover:bg-emerald-500"
              disabled={disabled}
              onClick={onComplete}
            >
              CLAIM
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-red-500/40 bg-red-500/10 px-2 text-[10px] font-bold text-red-400 hover:bg-red-500/20"
            disabled={disabled}
            onClick={onCancel}
            aria-label={`Cancel ${item.count}× ${item.unitName}`}
          >
            CANCEL
          </Button>
        </span>
      </div>
    </div>
  )
}

interface ArmyUnitRowProps {
  unit: {
    unitId: string
    name: string
    class: string
    tier: number
    count: number
    attack: number
    defense: number
    health: number
    speed: number
    foodUpkeep: number
    carryCapacity: number
  }
  catalog: CatalogUnitView | undefined
}

/** One roster row: owned count, stats, upkeep and training gate/cost preview. */
function ArmyUnitRow({ unit, catalog }: ArmyUnitRowProps) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          <span aria-hidden>{UNIT_CLASS_ICONS[unit.class] ?? '⚔️'}</span>{' '}
          <span className="font-semibold text-zinc-200">{unit.name}</span>{' '}
          <span className="text-[10px] text-zinc-500">
            T{unit.tier} · {UNIT_CLASS_LABELS[unit.class] ?? unit.class}
          </span>
        </span>
        <span
          className={`shrink-0 font-bold ${unit.count > 0 ? 'text-amber-400' : 'text-zinc-600'}`}
        >
          ×{unit.count.toLocaleString('en-US')}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-[10px] text-zinc-500">
          atk {unit.attack} · def {unit.defense} · hp {unit.health} · spd {unit.speed} · upkeep{' '}
          {unit.foodUpkeep}/h · carry {unit.carryCapacity}
        </span>
        {catalog ? (
          <span className="min-w-0 text-right text-[10px] [overflow-wrap:anywhere]">
            <span className="text-zinc-500">
              {catalog.trainingBuildingName} lv{catalog.requiredBuildingLevel}:
            </span>{' '}
            <span className="text-zinc-400">{formatCost(catalog.trainingCost)}</span>
            <span className="text-zinc-600"> · {catalog.trainingTimeSec}s</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

const PROTECTION_LABELS: Record<string, string> = {
  NEWBIE_SHIELD: 'newbie shield',
  INACTIVE_SHIELD: 'inactive',
  LEVEL_GAP: 'level gap',
  REPEATED_RAIDS: 'raid limit',
}

const LOOT_SHORT: Record<string, string> = {
  GOLD: 'Au',
  WOOD: 'Wd',
  IRON: 'Ir',
  FOOD: 'Fd',
  CRYSTAL: 'Cr',
}

function lootText(loot: Record<string, string> | null): string {
  if (!loot) return '—'
  const parts = Object.entries(loot)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([resource, amount]) => `${LOOT_SHORT[resource] ?? resource} ${formatAmount(amount)}`)
  return parts.length > 0 ? parts.join(' · ') : 'nothing carried'
}

function TargetRow({
  target,
  selected,
  disabled,
  onSelect,
}: {
  target: AttackTargetRow
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full rounded border px-2.5 py-2 text-left transition-colors ${
        selected
          ? 'border-amber-500/60 bg-amber-500/10'
          : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-600'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-zinc-200">
          {target.name} <span className="text-[10px] text-zinc-500">lv{target.level}</span>
        </span>
        {target.attackable ? (
          <span className="shrink-0 text-[10px] text-zinc-500">
            power <span className="text-amber-400">{formatAmount(target.power)}</span>
          </span>
        ) : (
          <Badge className="shrink-0 border border-zinc-700 bg-zinc-900 px-1.5 py-0 text-[10px] text-zinc-400">
            {target.blockedBy.map((r) => PROTECTION_LABELS[r] ?? r).join(' · ')}
          </Badge>
        )}
      </span>
    </button>
  )
}

function BattleResultPanel({ result }: { result: AttackResultView }) {
  const victory = result.outcome === 'VICTORY'
  const draw = result.outcome === 'DRAW'
  return (
    <div
      className={`rounded border px-3 py-3 ${
        victory
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : draw
            ? 'border-zinc-700 bg-zinc-900/60'
            : 'border-red-500/40 bg-red-500/5'
      }`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-lg font-black ${victory ? 'text-emerald-400' : draw ? 'text-zinc-300' : 'text-red-400'}`}
        >
          {victory ? '🏆 VICTORY' : draw ? '⚖️ DRAW' : '☠️ DEFEAT'}
        </span>
        <span className="text-[10px] text-zinc-500">
          {result.roundsCount} round{result.roundsCount === 1 ? '' : 's'}
          {result.unguardedCity ? ' · unguarded city' : ''} · seed {result.seed}
        </span>
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400 sm:grid-cols-2">
        <span>
          vs <span className="text-zinc-200">{result.opponent.name}</span> (lv
          {result.opponent.level})
        </span>
        <span>
          loot <span className="text-amber-400">{lootText(result.loot)}</span>
        </span>
        <span>
          your losses{' '}
          <span className="text-red-400">
            {result.casualties.attacker.reduce((s, r) => s + r.count, 0).toLocaleString('en-US')}
          </span>{' '}
          · enemy losses{' '}
          <span className="text-emerald-400">
            {result.casualties.defender.reduce((s, r) => s + r.count, 0).toLocaleString('en-US')}
          </span>
        </span>
        <span>
          honor <span className="text-amber-400">+{result.honor.attackerDelta}</span> · xp{' '}
          <span className="text-amber-400">+{result.xp.attackerGained}</span>
          {result.xp.attackerLevelsGained > 0
            ? ` · level ${result.xp.attackerLevel} (▲${result.xp.attackerLevelsGained})`
            : ''}
          {result.seasonPointsAwarded > 0 ? ` · season +${result.seasonPointsAwarded}` : ''}
        </span>
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-zinc-500">
        {result.casualties.attacker.map((row) => `${row.count}× ${row.unitName}`).join(', ') ||
          'no casualties'}
        {' · '}energy −{result.energySpent}
      </div>
    </div>
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
  const { data: city } = useCityQuery({ enabled: signedIn })
  const { data: army } = useArmyQuery({ enabled: signedIn })
  const { data: armyCatalog } = useArmyCatalogQuery({ enabled: signedIn })

  const { data: season } = useSeasonQuery({ enabled: signedIn })
  const { data: seasonRanking } = useSeasonRankingQuery({ enabled: signedIn, limit: 10 })
  const { data: seasonRewards } = useSeasonRewardsQuery({ enabled: signedIn })
  const { data: seasonProgression } = useSeasonProgressionQuery({ enabled: signedIn })

  const upgradeBuilding = useUpgradeBuildingMutation()
  const finishBuilding = useFinishBuildingMutation()
  const recruit = useRecruitMutation()
  const completeTraining = useCompleteTrainingMutation()
  const cancelTraining = useCancelTrainingMutation()
  const claimSeasonReward = useClaimSeasonRewardMutation()
  const equipTitle = useEquipTitleMutation()
  const attackTarget = useAttackMutation()

  // ── Battle console state (Phase 28) ─────────────────────────────────
  const { data: battleTargets } = useBattleTargetsQuery({ enabled: signedIn })
  const { data: battleHistory } = useBattleHistoryQuery({ enabled: signedIn })
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [confirmingAttack, setConfirmingAttack] = useState(false)
  const [lastBattle, setLastBattle] = useState<AttackResultView | null>(null)
  const [inspectBattleId, setInspectBattleId] = useState<string | null>(null)
  const battleDetail = useBattleDetailQuery(inspectBattleId)
  const selectedTarget = battleTargets?.targets.find((t) => t.playerId === selectedTargetId) ?? null

  // Recruitment form state — the server owns the real quantity ceiling; the
  // input is clamped defensively to a sane positive range before submit.
  const [trainUnitId, setTrainUnitId] = useState('swordsman')
  const [trainCount, setTrainCount] = useState('5')
  const trainCountNum = Number.parseInt(trainCount, 10)
  const trainCountValid =
    Number.isInteger(trainCountNum) && trainCountNum >= 1 && trainCountNum <= 10_000

  // Cosmetic 1s tick so construction/training countdowns advance (server clock
  // stays the authority — it decides whether a claim is accepted).
  const [nowTick, setNowTick] = useState(() => Date.now())
  const hasActiveConstruction = (city?.construction.activeCount ?? 0) > 0
  const hasActiveTraining = (army?.training.activeCount ?? 0) > 0
  useEffect(() => {
    if (!hasActiveConstruction && !hasActiveTraining) return
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasActiveConstruction, hasActiveTraining])

  const anyMutationPending =
    upgradeBuilding.isPending ||
    finishBuilding.isPending ||
    recruit.isPending ||
    completeTraining.isPending ||
    cancelTraining.isPending ||
    claimSeasonReward.isPending ||
    equipTitle.isPending ||
    attackTarget.isPending
  const mutationError =
    upgradeBuilding.error ??
    finishBuilding.error ??
    recruit.error ??
    completeTraining.error ??
    cancelTraining.error ??
    claimSeasonReward.error ??
    equipTitle.error ??
    attackTarget.error
  const mutationErrorDetail = (
    mutationError as (Error & { details?: { missing?: string[] } }) | null
  )?.details?.missing

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
              <div className="flex items-center gap-2">
                <NotificationBell enabled={signedIn} />
                <Badge className="bg-amber-500 px-3 py-1 text-sm font-bold text-zinc-950">
                  PHASE 28 COMPLETE
                </Badge>
              </div>
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

          {/* City & Building System — live from /api/v1/city with upgrade/finish mutations */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                City &amp; Building System
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    city
                      ? city.construction.activeCount > 0
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                      : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      city
                        ? city.construction.activeCount > 0
                          ? 'animate-pulse bg-amber-400'
                          : 'bg-emerald-400'
                        : 'bg-zinc-600'
                    }`}
                  />
                  {city
                    ? `${city.construction.activeCount}/${city.construction.queueSlots} QUEUE`
                    : signedIn
                      ? 'NO CITY'
                      : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {city ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        capital
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {city.city.name} @ ({city.city.x},{city.city.y})
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        production / h
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {(
                          [
                            ['GOLD', city.production.GOLD],
                            ['WOOD', city.production.WOOD],
                            ['IRON', city.production.IRON],
                            ['FOOD', city.production.FOOD],
                          ] as Array<[string, number]>
                        )
                          .map(([key, rate]) => `${SHORT_CODE[key]} ${rate}`)
                          .join(' · ')}
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        warehouse storage
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {city.storage.capacity.toLocaleString('en-US')}
                      </span>
                    </div>
                  </div>
                  <Separator className="bg-zinc-800" />
                  {mutationError ? (
                    <p className="text-red-400" role="alert">
                      {(mutationError as Error & { code?: string }).code ?? 'ERROR'}:{' '}
                      {mutationError.message ?? 'construction action failed'}
                      {mutationErrorDetail && mutationErrorDetail.length > 0 ? (
                        <span className="block text-[10px] text-red-400/80">
                          {mutationErrorDetail.join(' · ')}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {city.buildings.map((building) => (
                      <CityBuildingRow
                        key={building.id}
                        building={building}
                        nowTick={nowTick}
                        disabled={anyMutationPending}
                        onUpgrade={() => upgradeBuilding.mutate(building.type)}
                        onFinish={() => finishBuilding.mutate(building.type)}
                      />
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Server-side upgrades only: cost, duration, requirements and queue come from the
                    server catalog — the debit and the construction timer commit in ONE transaction
                    (ledger reason <span className="text-amber-400">BUILDING_UPGRADE</span>).
                    Concurrent starters converge behind the per-player mutex; double-spending is
                    structurally impossible. Completion is claimed against the server clock, then
                    power is recalculated from real state.
                  </p>
                </>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no city projection available — registration bootstraps the capital with all 17 buildings at level 1.'
                    : 'Anonymous — sign in to view the live city and start construction.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Army & Unit System — live from /api/v1/army with train/complete/cancel mutations */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                Army &amp; Unit System
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    army
                      ? army.training.activeCount > 0
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                      : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      army
                        ? army.training.activeCount > 0
                          ? 'animate-pulse bg-amber-400'
                          : 'bg-emerald-400'
                        : 'bg-zinc-600'
                    }`}
                  />
                  {army
                    ? `${army.totals.unitCount.toLocaleString('en-US')} UNITS · ${army.training.activeCount}/${army.training.queueSlots} QUEUE`
                    : signedIn
                      ? 'NO ARMY'
                      : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {army ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        standing army
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {army.totals.unitCount.toLocaleString('en-US')} units · carry{' '}
                        {army.totals.carryCapacity.toLocaleString('en-US')}
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        food upkeep / h
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {army.totals.upkeepFood.toLocaleString('en-US')} Fd
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        training speed (bps)
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {(
                          [
                            ['BARRACKS', army.training.speedBps['BARRACKS']],
                            ['ARCHER_CAMP', army.training.speedBps['ARCHER_CAMP']],
                            ['STABLE', army.training.speedBps['STABLE']],
                            ['ARMORY', army.training.speedBps['ARMORY']],
                          ] as Array<[string, number | undefined]>
                        )
                          .filter(([, speed]) => speed !== undefined)
                          .map(
                            ([key, speed]) =>
                              `${BUILDING_ICONS[key] ?? ''}${speed?.toLocaleString('en-US')}`,
                          )
                          .join(' · ')}
                      </span>
                    </div>
                  </div>
                  <Separator className="bg-zinc-800" />
                  {/* Recruitment — the client sends ONLY a unit id + quantity;
                      every cost/duration/gate decision is server-side. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="train-unit" className="sr-only">
                      Unit to train
                    </label>
                    <select
                      id="train-unit"
                      value={trainUnitId}
                      onChange={(e) => setTrainUnitId(e.target.value)}
                      className="h-8 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                    >
                      {army.units.map((u) => (
                        <option key={u.unitId} value={u.unitId}>
                          {UNIT_CLASS_ICONS[u.class] ?? ''} {u.name} (T{u.tier})
                        </option>
                      ))}
                    </select>
                    <label htmlFor="train-count" className="sr-only">
                      Batch size
                    </label>
                    <input
                      id="train-count"
                      type="number"
                      min={1}
                      step={1}
                      value={trainCount}
                      onChange={(e) => setTrainCount(e.target.value)}
                      className="h-8 w-20 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                      aria-label="Units per batch"
                    />
                    <Button
                      size="sm"
                      className="h-8 bg-amber-500 px-3 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
                      disabled={anyMutationPending || !trainCountValid}
                      onClick={() => recruit.mutate({ unitId: trainUnitId, count: trainCountNum })}
                    >
                      RECRUIT
                    </Button>
                    <span className="text-[10px] text-zinc-600">
                      cost × time = queue window — debited atomically (UNIT_TRAINING)
                    </span>
                  </div>
                  {mutationError ? (
                    <p className="text-red-400" role="alert">
                      {(mutationError as Error & { code?: string }).code ?? 'ERROR'}:{' '}
                      {mutationError.message ?? 'army action failed'}
                      {mutationErrorDetail && mutationErrorDetail.length > 0 ? (
                        <span className="block text-[10px] text-red-400/80">
                          {mutationErrorDetail.join(' · ')}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {/* Live FIFO training queue */}
                  {army.training.queue.length > 0 ? (
                    <div className="space-y-1.5">
                      {army.training.queue.map((item, index) => (
                        <ArmyQueueRow
                          key={item.id}
                          item={item}
                          position={index + 1}
                          nowTick={nowTick}
                          disabled={anyMutationPending}
                          onComplete={() => completeTraining.mutate(item.id)}
                          onCancel={() => cancelTraining.mutate(item.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-zinc-500">training queue idle — recruit a batch above</p>
                  )}
                  {/* Roster — full active catalog with owned counts */}
                  <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
                    {army.units.map((unit) => (
                      <ArmyUnitRow
                        key={unit.unitId}
                        unit={unit}
                        catalog={armyCatalog?.units.find((c) => c.id === unit.unitId)}
                      />
                    ))}
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Server-side recruitment only: the roster, costs, timers, counters and building
                    gates come from the server catalog — the debit and the queue item commit in ONE
                    transaction (ledger reason <span className="text-amber-400">UNIT_TRAINING</span>
                    ). FIFO batches anchor behind the current tail; claims answer to the server
                    clock; cancellation refunds by policy (100% before start · 50% once under way)
                    and re-walks the queue. Unit counts have no client write path.
                  </p>
                </>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no army projection available — registration bootstraps the starter army (20 swordsmen · 10 archers).'
                    : 'Anonymous — sign in to view the live roster and recruit troops.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Seasonal System — live from /api/v1/season with claim + title-equip intents */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-zinc-100">
                Seasonal System
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    season?.season
                      ? season.season.status === 'ACTIVE'
                        ? 'text-emerald-400'
                        : 'text-orange-400'
                      : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      season?.season
                        ? season.season.status === 'ACTIVE'
                          ? 'bg-emerald-400'
                          : 'animate-pulse bg-orange-400'
                        : 'bg-zinc-600'
                    }`}
                  />
                  {season?.season
                    ? `${season.season.name.toUpperCase()} · ${season.season.status}${
                        season.settlementPending ? ' · RESET PENDING' : ''
                      }`
                    : signedIn
                      ? 'NO SEASON'
                      : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {season && seasonRanking ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        my season points
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {season.me.seasonPoints.toLocaleString('en-US')}
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        my rank
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {season.me.rank ? `#${season.me.rank}` : 'unranked'}
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        season wallet (shards)
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {season.me.shards}
                      </span>
                    </div>
                    <div className="flex justify-between sm:block">
                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                        {season.season?.status === 'ACTIVE' ? 'ends in' : 'status'}
                      </span>
                      <span className="ml-2 text-zinc-200 sm:ml-0 sm:block">
                        {season.season?.timeLeftSec != null
                          ? `${Math.floor(season.season.timeLeftSec / 86400)}d ${Math.floor(
                              (season.season.timeLeftSec % 86400) / 3600,
                            )}h`
                          : season.settlementPending
                            ? 'awaiting reset'
                            : '—'}
                      </span>
                    </div>
                  </div>
                  <Separator className="bg-zinc-800" />
                  <div className="grid gap-3 md:grid-cols-2">
                    {/* Live top-10 — computed server-side, deterministic tie-break */}
                    <div>
                      <p className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                        live ranking · top 10
                      </p>
                      <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                        {seasonRanking.live.length > 0 ? (
                          seasonRanking.live.map((row: RankedRow) => (
                            <div
                              key={row.playerId}
                              className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 ${
                                seasonRanking.me.rank != null && row.rank === seasonRanking.me.rank
                                  ? 'border-amber-500/50'
                                  : 'border-zinc-800'
                              } bg-zinc-950/60`}
                            >
                              <span className="min-w-0 truncate">
                                <span
                                  className={`mr-2 font-bold ${
                                    row.rank <= 3 ? 'text-amber-400' : 'text-zinc-500'
                                  }`}
                                >
                                  #{row.rank}
                                </span>
                                <span className="text-zinc-300">{row.playerName}</span>
                              </span>
                              <span className="shrink-0 text-[10px] text-zinc-500">
                                {row.score.toLocaleString('en-US')} pts
                                {row.tier ? ` · ${row.tier}` : ''}
                              </span>
                            </div>
                          ))
                        ) : (
                          <p className="text-zinc-500">
                            no ranked players yet — upgrades and training earn season points
                          </p>
                        )}
                      </div>
                    </div>
                    {/* Reward tiers + pending payouts */}
                    <div>
                      <p className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                        reward tiers
                      </p>
                      <div className="mb-2 space-y-1">
                        {season.rules.rewardTiers.map((tier) => (
                          <div
                            key={tier.name}
                            className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-zinc-300">
                                #{tier.fromRank}
                                {tier.toRank > tier.fromRank ? `–#${tier.toRank}` : ''}
                              </span>
                              <span className="text-[10px] text-amber-400">{tier.name}</span>
                            </div>
                            <p className="mt-0.5 text-[10px] text-zinc-500">
                              {Object.entries(tier.resources)
                                .map(
                                  ([res, amount]) =>
                                    `${SHORT_CODE[res] ?? res} ${amount.toLocaleString('en-US')}`,
                                )
                                .join(' · ')}
                              {tier.titles.length > 0 ? ` · ${tier.titles.length} title` : ''}
                              {tier.cosmetics.length > 0
                                ? ` · ${tier.cosmetics.length} cosmetic`
                                : ''}
                            </p>
                          </div>
                        ))}
                      </div>
                      {(seasonRewards?.pending.length ?? 0) > 0 ? (
                        <div className="space-y-1">
                          <p className="text-[11px] uppercase tracking-wider text-emerald-400">
                            claimable rewards
                          </p>
                          {seasonRewards!.pending.map((payout: SeasonRewardPayout) => (
                            <div
                              key={payout.seasonId}
                              className="flex items-center justify-between gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5"
                            >
                              <span className="min-w-0 text-[10px] text-zinc-300">
                                S{payout.seasonNumber} #{payout.rank} {payout.tierName}
                              </span>
                              <Button
                                size="sm"
                                className="h-7 shrink-0 bg-emerald-600 px-2 text-[10px] font-bold text-zinc-950 hover:bg-emerald-500"
                                disabled={claimSeasonReward.isPending}
                                onClick={() => claimSeasonReward.mutate(payout.seasonId)}
                              >
                                CLAIM
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {season.settlementPending ? (
                        <p className="mt-2 text-[10px] text-orange-400">
                          Season {season.season?.number} ended — the transactional reset settles
                          rankings and rewards (admin simulate → execute).
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {/* Permanent progression — survives every reset */}
                  {seasonProgression ? (
                    <>
                      <Separator className="bg-zinc-800" />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
                          permanent progression:
                        </span>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-[10px] text-zinc-400"
                        >
                          {seasonProgression.achievements.length} achievements
                        </Badge>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-[10px] text-zinc-400"
                        >
                          {seasonProgression.cosmetics.length} cosmetics
                        </Badge>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-[10px] text-zinc-400"
                        >
                          {seasonProgression.titles.length} titles
                        </Badge>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-[10px] text-zinc-400"
                        >
                          {seasonProgression.commanders.length} commanders
                        </Badge>
                        {seasonProgression.titles.length > 0 ? (
                          <select
                            aria-label="Equip a title"
                            value={seasonProgression.equippedTitleId ?? ''}
                            onChange={(e) => equipTitle.mutate(e.target.value || null)}
                            className="h-7 rounded border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300"
                          >
                            <option value="">— no title —</option>
                            {seasonProgression.titles.map((title) => (
                              <option key={title.id} value={title.id}>
                                {title.name} ({title.rarity})
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-500">
                        Server-driven seasons: the lifecycle answers to the server clock; points are
                        computed inside the transactions of real actions (
                        <span className="text-amber-400">
                          {season.rules.score.buildingLevelUpPointsPerNewLevel} pts/level ·{' '}
                          {season.rules.score.unitTrainedPointsPerTier.join('/')} pts/unit by tier
                        </span>
                        ); the reset is a single transaction that wipes
                        <span className="text-orange-400">
                          {' '}
                          season points · territory · season wallets · seasonal commanders
                        </span>{' '}
                        while achievements, cosmetics, titles and permanent commanders are preserved
                        — and it is simulated (rolled-back dry-run) before it can execute.
                      </p>
                    </>
                  ) : null}
                </>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no season projection available — the season scheduler resolves the lifecycle on access.'
                    : 'Anonymous — sign in to view the live season, ranking and your progression.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Battle Engine — live from /api/v1/battles/* (Phase 28) */}
          <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
                Battle Engine
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold ${
                    battleTargets ? 'text-emerald-400' : 'text-zinc-500'
                  }`}
                  aria-live="polite"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      battleTargets ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {battleTargets
                    ? `${battleTargets.attacker.armyUnits} UNITS READY`
                    : signedIn
                      ? 'NO ARMY DATA'
                      : 'SIGN IN TO VIEW'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
              {battleTargets ? (
                <>
                  {/* Attack readiness strip */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span>
                      energy{' '}
                      <span className="text-amber-400">
                        {battleTargets.attacker.energy}/{battleTargets.attacker.energyMax}
                      </span>
                    </span>
                    <span>
                      attack cost{' '}
                      <span className="text-zinc-300">{battleTargets.attacker.attackCost}</span>
                    </span>
                    <span>
                      cooldown{' '}
                      {battleTargets.attacker.cooldownRemainingSec > 0 ? (
                        <span className="text-red-400">
                          {battleTargets.attacker.cooldownRemainingSec}s
                        </span>
                      ) : (
                        <span className="text-emerald-400">clear</span>
                      )}
                    </span>
                  </div>

                  <Separator className="bg-zinc-800" />

                  <div className="grid gap-4 md:grid-cols-2">
                    {/* Target roster */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        Targets (armies hidden until battle)
                      </p>
                      <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                        {battleTargets.targets.length > 0 ? (
                          battleTargets.targets.map((target) => (
                            <TargetRow
                              key={target.playerId}
                              target={target}
                              selected={target.playerId === selectedTargetId}
                              disabled={target.attackable !== true}
                              onSelect={() => {
                                setSelectedTargetId(target.playerId)
                                setConfirmingAttack(false)
                                setLastBattle(null)
                              }}
                            />
                          ))
                        ) : (
                          <p className="text-zinc-500">No other players in the world yet.</p>
                        )}
                      </div>
                    </div>

                    {/* Confirmation / result */}
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        {lastBattle ? 'Battle result' : 'Attack order'}
                      </p>
                      {lastBattle ? (
                        <BattleResultPanel result={lastBattle} />
                      ) : selectedTarget ? (
                        <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-zinc-200">
                              {profile?.name ?? 'Your army'}
                            </span>
                            <span className="text-[10px] text-zinc-600">vs</span>
                            <span className="font-semibold text-zinc-200">
                              {selectedTarget.name}{' '}
                              <span className="text-[10px] text-zinc-500">
                                lv{selectedTarget.level}
                              </span>
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                            <span>
                              your power{' '}
                              <span className="text-amber-400">
                                {profile ? formatAmount(profile.power.toString()) : '—'}
                              </span>
                            </span>
                            <span>
                              target power{' '}
                              <span className="text-amber-400">
                                {formatAmount(selectedTarget.power)}
                              </span>
                            </span>
                            <span>
                              energy cost{' '}
                              <span
                                className={
                                  battleTargets.attacker.energy >= battleTargets.attacker.attackCost
                                    ? 'text-emerald-400'
                                    : 'text-red-400'
                                }
                              >
                                −{battleTargets.attacker.attackCost}
                              </span>
                            </span>
                            <span>
                              risk{' '}
                              <span className="text-zinc-300">
                                {Number(selectedTarget.power) > Number(profile?.power ?? 0)
                                  ? 'dangerous'
                                  : 'favorable'}
                              </span>
                            </span>
                          </div>
                          <p className="text-[10px] leading-relaxed text-zinc-500">
                            Casualties are permanent. The server decides everything — you only
                            choose the target.
                          </p>
                          {confirmingAttack ? (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="h-8 flex-1 bg-red-600 text-[11px] font-bold text-zinc-950 hover:bg-red-500"
                                disabled={
                                  attackTarget.isPending ||
                                  !selectedTarget.attackable ||
                                  battleTargets.attacker.energy <
                                    battleTargets.attacker.attackCost ||
                                  battleTargets.attacker.cooldownRemainingSec > 0 ||
                                  battleTargets.attacker.armyUnits === 0
                                }
                                onClick={() =>
                                  attackTarget.mutate(
                                    { targetPlayerId: selectedTarget.playerId },
                                    {
                                      onSuccess: (result) => {
                                        setLastBattle(result)
                                        setConfirmingAttack(false)
                                      },
                                    },
                                  )
                                }
                              >
                                {attackTarget.isPending ? 'FIGHTING…' : '⚔ CONFIRM ATTACK'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-zinc-700 px-3 text-[11px] text-zinc-400"
                                disabled={attackTarget.isPending}
                                onClick={() => setConfirmingAttack(false)}
                              >
                                CANCEL
                              </Button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              className="h-8 w-full bg-amber-500 text-[11px] font-black text-zinc-950 hover:bg-amber-400"
                              disabled={
                                !selectedTarget.attackable ||
                                battleTargets.attacker.energy < battleTargets.attacker.attackCost ||
                                battleTargets.attacker.cooldownRemainingSec > 0 ||
                                battleTargets.attacker.armyUnits === 0
                              }
                              onClick={() => setConfirmingAttack(true)}
                            >
                              ATTACK {selectedTarget.name.toUpperCase()}
                            </Button>
                          )}
                        </div>
                      ) : (
                        <p className="text-zinc-500">Select a target to plan an attack.</p>
                      )}
                    </div>
                  </div>

                  <Separator className="bg-zinc-800" />

                  {/* Battle history */}
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Battle history ({battleHistory?.total ?? 0})
                    </p>
                    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                      {battleHistory && battleHistory.battles.length > 0 ? (
                        battleHistory.battles.map((row) => (
                          <div
                            key={row.battleId}
                            className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2"
                          >
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 truncate">
                                <Badge
                                  className={`mr-1.5 px-1.5 py-0 text-[10px] ${
                                    row.outcome === 'VICTORY'
                                      ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                      : row.outcome === 'DRAW'
                                        ? 'border border-zinc-700 bg-zinc-900 text-zinc-300'
                                        : 'border border-red-500/40 bg-red-500/15 text-red-300'
                                  }`}
                                >
                                  {row.outcome}
                                </Badge>
                                <span className="text-zinc-400">
                                  {row.myRole === 'ATTACKER' ? 'attacked' : 'defended against'}{' '}
                                  <span className="text-zinc-200">{row.opponent.name ?? '—'}</span>
                                </span>
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 shrink-0 px-2 text-[10px] text-amber-400 hover:bg-amber-500/10"
                                onClick={() =>
                                  setInspectBattleId(
                                    inspectBattleId === row.battleId ? null : row.battleId,
                                  )
                                }
                                aria-expanded={inspectBattleId === row.battleId}
                              >
                                {inspectBattleId === row.battleId ? 'HIDE' : 'REPORT'}
                              </Button>
                            </div>
                            <div className="mt-0.5 text-[10px] text-zinc-600">
                              {formatTime(row.startedAt)} · {row.roundsCount} rounds ·{' '}
                              {lootText(row.loot)} · honor{' '}
                              {row.honorDelta > 0 ? `+${row.honorDelta}` : row.honorDelta}
                            </div>
                            {inspectBattleId === row.battleId && battleDetail.data ? (
                              <div className="mt-1.5 space-y-1 border-t border-zinc-800 pt-1.5 text-[10px] text-zinc-500">
                                {battleDetail.data.rounds.length === 0 ? (
                                  <p>Unguarded city — the battle ended before it began.</p>
                                ) : (
                                  battleDetail.data.rounds.map((round, index) => (
                                    <p key={`${round.roundNumber}-${round.side}-${index}`}>
                                      R{round.roundNumber} {round.side}: dealt{' '}
                                      <span className="text-zinc-300">
                                        {formatAmount(round.damageDealt)}
                                      </span>{' '}
                                      dmg
                                      {round.unitsLost.length > 0
                                        ? ` · lost ${round.unitsLost
                                            .map((l) => `${l.count}× ${l.unitTypeId}`)
                                            .join(', ')}`
                                        : ''}
                                    </p>
                                  ))
                                )}
                                <p className="text-zinc-600">
                                  seed {battleDetail.data.seed} · config v
                                  {battleDetail.data.configVersion} · deterministic replay
                                </p>
                              </div>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <p className="text-zinc-500">No battles yet — pick a target above.</p>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Server-authoritative combat: a seeded PRNG (crypto seed, snapshotted config
                    version) drives every swing — same seed + same armies ⇒ identical battle, so
                    every report is replayable and auditable. Loot crosses the ledger (
                    <span className="text-amber-400">BATTLE_REWARD</span>), defeats never destroy
                    progression, and protection rules (newbie · inactive · level gap · raid limit ·
                    cooldown) are enforced before the first sword swings.
                  </p>
                </>
              ) : (
                <p className="leading-relaxed text-zinc-500">
                  {signedIn
                    ? 'Signed in but no battle projection available.'
                    : 'Anonymous — sign in to review targets, attack, and read battle reports.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Quests & Achievements — live from /api/v1/quests* (Phase 31);
              self-contained section card: hooks inside, enabled while signed in */}
          <QuestsSection signedIn={signedIn} />

          {/* World Map & Territories — live from /api/v1/world* (Phase 32);
              self-contained section card: hooks inside, enabled while signed in */}
          <WorldMapSection signedIn={signedIn} />

          {/* Marches — live from /api/v1/marches* (Phase 33); self-contained
              section card: hooks inside, enabled while signed in */}
          <MarchesSection signedIn={signedIn} />

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

        {/* Admin Panel — rendered only for DB-backed staff sessions; every
            action it offers is enforced server-side by the RBAC scope guard */}
        <div className="mt-6 grid gap-4">
          <AdminPanel />
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

        {/* Phase deliverables */}
        <Card className="mt-6 border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-zinc-100">
              Phase 28 — Battle Engine Deliverables
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
                Quality gate — lint · typecheck · format · full test suites green · production build
                (standalone) · smoke test · health checks (/health · /ready · /api/health) · secrets
                scan · PG migration set validated
              </span>
              <code className="min-w-0 shrink text-right font-mono text-[10px] leading-snug text-amber-400 [overflow-wrap:anywhere]">
                build ✓ health ✓ ready ✓ webhook ✓ docker ✓ migrations ✓ env ✓ guide ✓
              </code>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* ── Sticky footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-1 px-4 py-4 text-[11px] text-zinc-600 sm:flex-row sm:px-6">
          <span>WARLORDS Dev Console · Phase 28 · battle engine live</span>
          <span className="font-mono">server-authoritative · never trust the client</span>
        </div>
      </footer>
    </div>
  )
}
