/**
 * WARLORDS — Season service (Phase 20: Seasonal System).
 *
 * Server-driven season lifecycle, ranking, points awarding, reward claims and
 * the permanent-progression read model. The CLIENT has no write surface over
 * any of it: status transitions answer to the server clock, points are
 * computed inside the transactions of real game actions, and reward payouts
 * flow through the ledger with an idempotency key.
 *
 * Scheduler architecture: every read/mutation lazily resolves the season
 * state machine (UPCOMING → ACTIVE → FINISHED) against the server clock via
 * `resolveSeasonStateInTx`, so a cron ticker needs nothing more than calling
 * any season endpoint (or `ensureActiveSeasonInTx` directly). The heavy
 * season RESET is deliberately NOT part of lazy resolution — it is a
 * distinct, at-most-once, transactional settlement (season-settlement.service)
 * that operators simulate first and execute second.
 *
 * Status semantics:
 *   UPCOMING  — created, startsAt in the future
 *   ACTIVE    — now ∈ [startsAt, endsAt)
 *   FINISHED  — now ≥ endsAt (settledAt still null until the reset ran;
 *               settlementPending is surfaced to operators)
 *
 * Auto-renewal guard: a next season is only auto-created when the latest
 * season is settled (or none exists) — an ended-but-unsettled season blocks
 * renewal so the reset can never be silently skipped.
 */

import { Prisma } from '@prisma/client'
import { db, dbWrite } from '@/lib/db'
import { AppError, errors } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import { runEconomyTransaction, grantResources, ECONOMY_TX_OPTIONS } from './economy.service'
import {
  PERMANENT_PROGRESSION_CATALOG,
  SEASONAL_RESET_CATALOG,
  SEASON_RULES,
  seasonTierForRank,
  validateSeasonRules,
  type SeasonRewardTier,
  type SeasonRules,
} from '@/lib/game/config/seasons'

const log = logger.child({ module: 'game/season' })

type ReadClient = Tx | typeof db

/** Memoized config validation — a broken config fails the first caller. */
let rulesValidated = false
export function seasonRulesOrThrow(): SeasonRules {
  if (!rulesValidated) {
    const problems = validateSeasonRules()
    if (problems.length > 0) {
      throw new AppError('INTERNAL_ERROR', `Season rules config invalid: ${problems.join('; ')}`)
    }
    rulesValidated = true
  }
  return SEASON_RULES
}

// ── Lifecycle cores (tx-scoped) ──────────────────────────────────────────────

export type SeasonStatus = 'UPCOMING' | 'ACTIVE' | 'FINISHED'

export interface SeasonRow {
  id: string
  number: number
  name: string
  startsAt: Date
  endsAt: Date
  status: string
  settledAt: Date | null
  config: unknown
}

/** Applies the server-clock state machine to the CURRENT season row (if any). */
export async function resolveSeasonStateInTx(tx: Tx, now = new Date()): Promise<SeasonRow | null> {
  const current = (await tx.season.findFirst({
    orderBy: { number: 'desc' },
  })) as SeasonRow | null
  if (!current) return null

  if (current.status === 'UPCOMING' && current.startsAt.getTime() <= now.getTime()) {
    await tx.season.updateMany({
      where: { id: current.id, status: 'UPCOMING' },
      data: { status: 'ACTIVE' },
    })
    current.status = 'ACTIVE'
    log.info('season activated by scheduler', { seasonNumber: current.number })
  }

  if (current.status === 'ACTIVE' && current.endsAt.getTime() <= now.getTime()) {
    await tx.season.updateMany({
      where: { id: current.id, status: 'ACTIVE' },
      data: { status: 'FINISHED' },
    })
    current.status = 'FINISHED'
    log.info('season finished by scheduler (awaiting settlement)', {
      seasonNumber: current.number,
    })
  }

  return current
}

/**
 * READ-PATH season resolution — no interactive transaction.
 *
 * Rationale (Phase 25): Prisma's SQLite interactive transactions run
 * `BEGIN IMMEDIATE`, taking the database's RESERVED (write) lock — so
 * wrapping a pure read projection in `$transaction` serializes EVERY such
 * read behind the single global writer. The clock transitions here are
 * guarded conditional `updateMany` statements, which are atomic on their
 * own; losing the race to another process just means re-reading the row.
 * Transactional callers (awardSeasonPointsInTx, settlement) keep using
 * `resolveSeasonStateInTx` inside their existing transaction.
 */
export async function resolveSeasonState(now = new Date()): Promise<SeasonRow | null> {
  const current = (await db.season.findFirst({
    orderBy: { number: 'desc' },
  })) as SeasonRow | null
  if (!current) return null

  const transition = async (
    from: string,
    to: 'ACTIVE' | 'FINISHED',
    message: string,
  ): Promise<boolean> => {
    const claim = await db.season.updateMany({
      where: { id: current.id, status: from },
      data: { status: to },
    })
    if (claim.count === 1) {
      current.status = to
      log.info(message, { seasonNumber: current.number })
      return true
    }
    // Another process flipped it first — adopt the authoritative row.
    const fresh = (await db.season.findUnique({ where: { id: current.id } })) as SeasonRow | null
    if (fresh) current.status = fresh.status
    return false
  }

  if (current.status === 'UPCOMING' && current.startsAt.getTime() <= now.getTime()) {
    await transition('UPCOMING', 'ACTIVE', 'season activated by scheduler')
  }
  if (current.status === 'ACTIVE' && current.endsAt.getTime() <= now.getTime()) {
    await transition('ACTIVE', 'FINISHED', 'season finished by scheduler (awaiting settlement)')
  }

  return current
}

/**
 * Scheduler entry point: resolves state and guarantees an ACTIVE season
 * exists. Auto-renewal ONLY when the latest season is settled — an ended but
 * unsettled season blocks renewal (the reset must run first, deliberately).
 */
export async function ensureActiveSeasonInTx(tx: Tx, now = new Date()): Promise<SeasonRow> {
  const rules = seasonRulesOrThrow()
  const current = await resolveSeasonStateInTx(tx, now)

  if (current && current.status !== 'FINISHED') return current

  const renewalAllowed =
    current === null || // fresh world — bootstrap the first season
    current.settledAt !== null // latest season fully reset — safe to continue

  if (!renewalAllowed) {
    return current as SeasonRow // ended, settlement pending — callers see FINISHED
  }

  const nextNumber = (current?.number ?? 0) + 1
  const startsAt = now
  const endsAt = new Date(startsAt.getTime() + rules.durationDays * 24 * 3600 * 1000)
  const created = await tx.season.create({
    data: {
      number: nextNumber,
      name: rules.namePattern.replace('{n}', String(nextNumber)),
      startsAt,
      endsAt,
      status: 'ACTIVE',
      config: rules as unknown as Prisma.InputJsonValue,
    },
  })
  log.info('season created by scheduler', { seasonNumber: nextNumber })
  return created as unknown as SeasonRow
}

/**
 * Awards season points inside the CALLER's transaction (the real action's
 * tx — building upgrade claim, training claim). Zero writes when no ACTIVE
 * season exists (between seasons points simply stop accruing).
 */
export async function awardSeasonPointsInTx(
  tx: Tx,
  playerId: string,
  points: number,
  source: 'BUILDING_LEVEL_UP' | 'UNIT_TRAINED',
  sourceMeta: Record<string, number | string>,
): Promise<number> {
  if (!Number.isInteger(points) || points <= 0) return 0
  const now = new Date()
  const season = await resolveSeasonStateInTx(tx, now)
  if (!season || season.status !== 'ACTIVE') return 0

  await tx.player.updateMany({
    where: { id: playerId },
    data: { seasonPoints: { increment: points } },
  })
  log.info('season points awarded', {
    playerId,
    points,
    source,
    seasonNumber: season.number,
    ...sourceMeta,
  })
  return points
}

// ── Read models ──────────────────────────────────────────────────────────────

export interface SeasonTierPreview {
  name: string
  fromRank: number
  toRank: number
  resources: Record<string, number>
  titles: string[]
  cosmetics: string[]
}

export interface SeasonView {
  /** Null only for a fresh world before the first season exists. */
  season: {
    id: string
    number: number
    name: string
    status: SeasonStatus
    startsAt: string
    endsAt: string
    timeLeftSec: number | null
    settledAt: string | null
  } | null
  rules: {
    durationDays: number
    score: SeasonRules['score']
    rewardTiers: SeasonTierPreview[]
    permanentProgression: string[]
    seasonalReset: string[]
  }
  me: {
    seasonPoints: number
    rank: number | null
    shards: string
  }
  settlementPending: boolean
}

function tierPreview(tier: SeasonRewardTier): SeasonTierPreview {
  return {
    name: tier.name,
    fromRank: tier.fromRank,
    toRank: tier.toRank,
    resources: tier.resources,
    titles: tier.titleIds,
    cosmetics: tier.cosmeticIds,
  }
}

/** Deterministic live rank of `playerId` (seasonPoints desc, then id asc). */
async function liveRankOf(
  client: ReadClient,
  playerId: string,
  points: number,
): Promise<number | null> {
  if (points <= 0) return null
  const ahead = await client.player.count({
    where: { seasonPoints: { gt: points } },
  })
  const tieBefore = await client.player.count({
    where: { seasonPoints: points, id: { lt: playerId } },
  })
  return ahead + tieBefore + 1
}

export async function getSeasonView(playerId: string): Promise<SeasonView> {
  const rules = seasonRulesOrThrow()
  // Read-path: plain statements, NO interactive transaction — see
  // resolveSeasonState for the SQLite BEGIN IMMEDIATE rationale.
  const now = new Date()
  const season = await resolveSeasonState(now)
  const player = await db.player.findUnique({
    where: { id: playerId },
    select: { seasonPoints: true, createdAt: true },
  })
  if (!player) throw errors.notFoundPlayer()

  let shards = 0n
  if (season) {
    const wallet = await db.seasonWallet.findUnique({
      where: { seasonId_playerId: { seasonId: season.id, playerId } },
      select: { shards: true },
    })
    shards = wallet?.shards ?? 0n
  }

  const rank = await liveRankOf(db, playerId, player.seasonPoints)
  const timeLeftSec =
    season && season.status === 'ACTIVE'
      ? Math.max(0, Math.ceil((season.endsAt.getTime() - now.getTime()) / 1000))
      : null

  return {
    season: season
      ? {
          id: season.id,
          number: season.number,
          name: season.name,
          status: season.status as SeasonStatus,
          startsAt: season.startsAt.toISOString(),
          endsAt: season.endsAt.toISOString(),
          timeLeftSec,
          settledAt: season.settledAt?.toISOString() ?? null,
        }
      : null,
    rules: {
      durationDays: rules.durationDays,
      score: rules.score,
      rewardTiers: rules.rewardTiers.map(tierPreview),
      permanentProgression: [...PERMANENT_PROGRESSION_CATALOG],
      seasonalReset: [...SEASONAL_RESET_CATALOG],
    },
    me: {
      seasonPoints: player.seasonPoints,
      rank,
      shards: shards.toString(),
    },
    settlementPending: (season?.status === 'FINISHED' && season.settledAt === null) || false,
  }
}

// ── Ranking ──────────────────────────────────────────────────────────────────

export interface RankedRow {
  rank: number
  playerId: string
  playerName: string
  score: number
  tier: string | null
}

export interface SeasonRankingView {
  seasonId: string
  seasonNumber: number
  seasonStatus: SeasonStatus
  /** LIVE ranking (computed from real season points) for the running season. */
  live: RankedRow[]
  /** MATERIALIZED history (Leaderboard rows) — present only for settled seasons. */
  history: RankedRow[] | null
  me: { rank: number | null; score: number }
}

const RANKING_LIMIT_MIN = 1
const RANKING_LIMIT_MAX = 100

export async function getSeasonRankingView(
  playerId: string,
  rawLimit: number = 10,
  seasonId?: string,
): Promise<SeasonRankingView> {
  const rules = seasonRulesOrThrow()
  const limit = Math.min(
    Math.max(Math.floor(rawLimit) || RANKING_LIMIT_MIN, RANKING_LIMIT_MIN),
    RANKING_LIMIT_MAX,
  )

  if (seasonId !== undefined) {
    // History view — only materialized rows for SETTLED seasons are served.
    const season = await db.season.findUnique({ where: { id: seasonId } })
    if (!season) throw new AppError('SEASON_NOT_FOUND', 'Season not found')
    if (season.settledAt === null) {
      throw new AppError('SEASON_NOT_SETTLED', 'Season ranking history is not available yet')
    }
    const rows = await db.leaderboard.findMany({
      where: { seasonId, category: 'SEASON', period: 'SEASONAL' },
      orderBy: { rank: 'asc' },
      take: limit,
      include: { player: { select: { name: true } } },
    })
    return {
      seasonId: season.id,
      seasonNumber: season.number,
      seasonStatus: 'FINISHED',
      live: [],
      history: rows.map((row) => ({
        rank: row.rank,
        playerId: row.playerId,
        playerName: row.player.name,
        score: Number(row.score),
        tier: seasonTierForRank(row.rank, rules)?.name ?? null,
      })),
      me: { rank: null, score: 0 },
    }
  }

  const result = await (async () => {
    // Read-path: plain statements, NO interactive transaction — see
    // resolveSeasonState for the SQLite BEGIN IMMEDIATE rationale.
    const now = new Date()
    const season = await resolveSeasonState(now)
    if (!season) throw new AppError('SEASON_NOT_FOUND', 'No season exists yet')

    const me = await db.player.findUnique({
      where: { id: playerId },
      select: { seasonPoints: true },
    })
    if (!me) throw errors.notFoundPlayer()

    const top = await db.player.findMany({
      where: { seasonPoints: { gte: rules.minScoreToRank } },
      orderBy: [{ seasonPoints: 'desc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, name: true, seasonPoints: true },
    })

    const live: RankedRow[] = top.map((player, index) => ({
      rank: index + 1,
      playerId: player.id,
      playerName: player.name,
      score: player.seasonPoints,
      tier: seasonTierForRank(index + 1, rules)?.name ?? null,
    }))

    const myRank = await liveRankOf(db, playerId, me.seasonPoints)
    return {
      seasonId: season.id,
      seasonNumber: season.number,
      seasonStatus: season.status as SeasonStatus,
      live,
      history: null,
      me: { rank: myRank, score: me.seasonPoints },
    }
  })()
  return result
}

// ── Reward claims (idempotent) ───────────────────────────────────────────────

export interface SeasonRewardPayout {
  seasonId: string
  seasonNumber: number
  rank: number
  score: number
  tierName: string
  rewards: Record<string, number>
  claimedAt: string | null
}

export interface ClaimSeasonRewardResult {
  claim: SeasonRewardPayout
  alreadyClaimed: boolean
  balances: Record<string, string>
}

interface ClaimRowFields {
  id: string
  seasonId: string
  playerId: string
  rank: number
  score: number
  tierName: string
  rewards: unknown
  claimedAt: Date | null
  season: { number: number } | null
}

function parseRewardResources(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value
  }
  return out
}

function toPayout(row: ClaimRowFields): SeasonRewardPayout {
  return {
    seasonId: row.seasonId,
    seasonNumber: row.season?.number ?? 0,
    rank: row.rank,
    score: row.score,
    tierName: row.tierName,
    rewards: parseRewardResources(row.rewards),
    claimedAt: row.claimedAt?.toISOString() ?? null,
  }
}

export async function getMySeasonRewardsView(playerId: string): Promise<{
  pending: SeasonRewardPayout[]
  claimed: SeasonRewardPayout[]
}> {
  const rows = (await db.seasonRewardClaim.findMany({
    where: { playerId },
    orderBy: { createdAt: 'desc' },
    include: { season: { select: { number: true } } },
  })) as unknown as ClaimRowFields[]

  const pending: SeasonRewardPayout[] = []
  const claimed: SeasonRewardPayout[] = []
  for (const row of rows) {
    ;(row.claimedAt === null ? pending : claimed).push(toPayout(row))
  }
  return { pending, claimed }
}

/**
 * Claims a settled season's reward payout — IDEMPOTENT, three layers deep:
 *   1. unique (seasonId, playerId) on the claim row (settlement-side)
 *   2. conditional `claimedAt IS NULL` update — count===1 is the arbiter
 *   3. ledger idempotency key `season_reward:{claimId}` on the grant itself
 * A replay returns the ORIGINAL payout result with alreadyClaimed: true —
 * a duplicate request can never pay out twice.
 */
export async function claimSeasonReward(
  playerId: string,
  seasonId: string,
): Promise<ClaimSeasonRewardResult> {
  if (typeof seasonId !== 'string' || seasonId.length === 0) {
    throw errors.validation('seasonId is required')
  }

  return runEconomyTransaction(playerId, async (tx) => {
    const claim = (await tx.seasonRewardClaim.findUnique({
      where: { seasonId_playerId: { seasonId, playerId } },
      include: { season: { select: { number: true, settledAt: true } } },
    })) as unknown as
      (ClaimRowFields & { season: { number: number; settledAt: Date | null } }) | null

    if (!claim) {
      throw new AppError('SEASON_REWARD_NOT_FOUND', 'No season reward is waiting for this claim')
    }
    if (claim.season.settledAt === null) {
      throw new AppError('SEASON_NOT_SETTLED', 'Season rewards are not claimable before settlement')
    }

    const payout = toPayout(claim)

    // Replay path — idempotent by design, same shape as the first result.
    if (claim.claimedAt !== null) {
      const balances = await walletStringBalances(tx, playerId)
      return { claim: payout, alreadyClaimed: true, balances }
    }

    const claimed = await tx.seasonRewardClaim.updateMany({
      where: { id: claim.id, claimedAt: null },
      data: { claimedAt: new Date() },
    })
    if (claimed.count === 0) {
      // Lost a concurrent claim race (multi-process backstop) — replay safely.
      const balances = await walletStringBalances(tx, playerId)
      return { claim: payout, alreadyClaimed: true, balances }
    }

    const rewards = payout.rewards
    const amounts: Partial<Record<keyof typeof rewards, bigint>> = {}
    for (const [resource, amount] of Object.entries(rewards)) {
      if (amount > 0) amounts[resource as keyof typeof rewards] = BigInt(amount)
    }

    if (Object.keys(amounts).length > 0) {
      await grantResources(tx, playerId, amounts as Record<string, bigint>, {
        reason: 'SEASON_REWARD',
        refType: 'season',
        refId: seasonId,
        metadata: { rank: payout.rank, tierName: payout.tierName, claimId: claim.id },
        idempotencyKey: `season_reward:${claim.id}`,
      })
    }

    const balances = await walletStringBalances(tx, playerId)
    payout.claimedAt = new Date().toISOString()
    log.info('season reward claimed', { playerId, seasonId, rank: payout.rank })
    return { claim: payout, alreadyClaimed: false, balances }
  })
}

async function walletStringBalances(tx: Tx, playerId: string): Promise<Record<string, string>> {
  const wallet = await tx.resourceWallet.findUnique({ where: { playerId } })
  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { gems: true },
  })
  if (!wallet || !player) throw errors.notFoundPlayer()
  return {
    GOLD: wallet.gold.toString(),
    WOOD: wallet.wood.toString(),
    IRON: wallet.iron.toString(),
    FOOD: wallet.food.toString(),
    CRYSTAL: wallet.crystal.toString(),
    GEMS: player.gems.toString(),
  }
}

// ── Permanent progression (titles · cosmetics · achievements · commanders) ───

export interface ProgressionTitle {
  id: string
  name: string
  rarity: string
  unlockedAt: string
  acquiredSeason: number | null
  active: boolean
}

export interface ProgressionCosmetic {
  id: string
  name: string
  kind: string
  rarity: string
  unlockedAt: string
  acquiredSeason: number | null
}

export interface ProgressionAchievement {
  id: string
  title: string
  description: string
  unlockedAt: string
}

export interface ProgressionCommander {
  id: string
  name: string
  rarity: string
  level: number
  seasonal: boolean
  unlockedAt: string
}

export interface SeasonProgressionView {
  titles: ProgressionTitle[]
  cosmetics: ProgressionCosmetic[]
  achievements: ProgressionAchievement[]
  commanders: ProgressionCommander[]
  equippedTitleId: string | null
}

export async function getSeasonProgressionView(playerId: string): Promise<SeasonProgressionView> {
  const player = await db.player.findUnique({
    where: { id: playerId },
    select: {
      activeTitleId: true,
      titles: {
        orderBy: { unlockedAt: 'asc' },
        include: { title: { select: { name: true, rarity: true } } },
      },
      cosmetics: {
        orderBy: { unlockedAt: 'asc' },
        include: { cosmetic: { select: { name: true, kind: true, rarity: true } } },
      },
      achievements: {
        orderBy: { unlockedAt: 'asc' },
        include: {
          achievement: { select: { title: true, description: true } },
        },
      },
      commanders: {
        orderBy: { unlockedAt: 'asc' },
        include: { commander: { select: { name: true, rarity: true, isSeasonal: true } } },
      },
    },
  })
  if (!player) throw errors.notFoundPlayer()

  return {
    titles: player.titles.map((row) => ({
      id: row.titleId,
      name: row.title.name,
      rarity: row.title.rarity,
      unlockedAt: row.unlockedAt.toISOString(),
      acquiredSeason: row.acquiredSeason,
      active: player.activeTitleId === row.titleId,
    })),
    cosmetics: player.cosmetics.map((row) => ({
      id: row.cosmeticId,
      name: row.cosmetic.name,
      kind: row.cosmetic.kind,
      rarity: row.cosmetic.rarity,
      unlockedAt: row.unlockedAt.toISOString(),
      acquiredSeason: row.acquiredSeason,
    })),
    achievements: player.achievements.map((row) => ({
      id: row.achievementId,
      title: row.achievement.title,
      description: row.achievement.description,
      unlockedAt: row.unlockedAt.toISOString(),
    })),
    commanders: player.commanders.map((row) => ({
      id: row.commanderId,
      name: row.commander.name,
      rarity: row.commander.rarity,
      level: row.level,
      seasonal: row.commander.isSeasonal,
      unlockedAt: row.unlockedAt.toISOString(),
    })),
    equippedTitleId: player.activeTitleId,
  }
}

/**
 * Equips an OWNED title (or clears with null). Ownership is checked against
 * the real PlayerTitle row — a client cannot equip a title it does not hold.
 */
export async function equipTitle(
  playerId: string,
  titleId: string | null,
): Promise<{ equippedTitleId: string | null }> {
  return withKeyLock(`wallet:${playerId}`, () =>
    withWriteRetry(() =>
      dbWrite.$transaction(async (tx) => {
        if (titleId !== null) {
          const owned = await tx.playerTitle.findUnique({
            where: { playerId_titleId: { playerId, titleId } },
            select: { id: true },
          })
          if (!owned) {
            throw new AppError('TITLE_NOT_OWNED', 'This title has not been unlocked')
          }
        }
        await tx.player.updateMany({
          where: { id: playerId },
          data: { activeTitleId: titleId },
        })
        return { equippedTitleId: titleId }
      }, ECONOMY_TX_OPTIONS),
    ),
  )
}
