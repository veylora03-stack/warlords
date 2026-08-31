/**
 * WARLORDS — Season settlement service (Phase 20: the transactional reset).
 *
 * The season reset is the most destructive operation in the game, so it is
 * engineered accordingly:
 *
 *  1. AT-MOST-ONCE — the first write in the transaction is a conditional
 *     claim (settledAt IS NULL → settled); concurrent executors converge on
 *     exactly one winner (count===1), the rest see SEASON_ALREADY_SETTLED.
 *  2. TRANSACTIONAL — final ranking, reward claims, permanent-progression
 *     grants, seasonal wipes, the next season and notifications share ONE
 *     transaction; any failure rolls back the entire reset.
 *  3. SIMULATED FIRST — `simulateSeasonSettlement` runs the IDENTICAL code
 *     path in a transaction that is rolled back at the end, producing a full
 *     report of what WOULD happen while persisting NOTHING (proven by tests).
 *     Operators run simulate → review → execute.
 *  4. DATA-DRIVEN — the wipe walks the SEASONAL_RESET_CATALOG; the grants
 *     walk the season's tier rules. Nothing is hard-coded at call sites.
 *
 * Reset semantics (user contract):
 *   PRESERVED (permanent): achievements · cosmetics · titles · permanent
 *   commanders · wallets/resources · buildings · units · power/level/xp.
 *   WIPED (seasonal): season points · territory ownership · season wallets ·
 *   seasonal commanders.
 *
 * The final ranking is materialized into Leaderboard rows (category SEASON,
 * period SEASONAL) as the immutable history of the finished season; every
 * reward-tier finisher additionally receives a SeasonRewardClaim row whose
 * resource payout is claimed idempotently through /season/rewards/claim.
 */

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import type { Tx } from './player-bootstrap.service'
import { ECONOMY_TX_OPTIONS } from './economy.service'
import {
  resolveSeasonStateInTx,
  seasonRulesOrThrow,
  type SeasonRow,
} from './season.service'
import {
  SEASONAL_RESET_CATALOG,
  type SeasonRewardTier,
  type SeasonRules,
} from '@/lib/game/config/seasons'

const log = logger.child({ module: 'game/season-settlement' })

// ── Report shapes (what simulate returns / execute logs) ─────────────────────

export interface SettlementTierReport {
  tierName: string
  fromRank: number
  toRank: number
  players: number
  resources: Record<string, number>
  titles: string[]
  cosmetics: string[]
  achievements: string[]
}

export interface SettlementReport {
  dryRun: boolean
  settledSeason: {
    id: string
    number: number
    name: string
    startedAt: string
    endedAt: string
  }
  rankedPlayers: number
  unrankedPlayers: number
  tiers: SettlementTierReport[]
  wipe: {
    seasonPointsReset: number
    territoriesStripped: number
    seasonWalletsDeleted: number
    seasonalCommandersDeleted: number
  }
  grants: {
    titlesGranted: number
    cosmeticsGranted: number
    achievementsGranted: number
    notificationsCreated: number
  }
  nextSeason: {
    number: number
    name: string
    startsAt: string
    endsAt: string
  } | null
}

// ── Settlement plan (shared core of simulate + execute) ──────────────────────

interface RankedPlayer {
  playerId: string
  playerName: string
  score: number
  rank: number
}

interface TierAssignment {
  tier: SeasonRewardTier
  players: RankedPlayer[]
}

async function finalRanking(tx: Tx, rules: SeasonRules): Promise<{
  ranked: RankedPlayer[]
  unrankedCount: number
}> {
  const [qualifying, total] = await Promise.all([
    tx.player.findMany({
      where: { seasonPoints: { gte: Math.max(rules.minScoreToRank, 1) } },
      orderBy: [{ seasonPoints: 'desc' }, { id: 'asc' }],
      select: { id: true, name: true, seasonPoints: true, createdAt: true },
    }),
    tx.player.count(),
  ])
  const ranked = qualifying.map((player, index) => ({
    playerId: player.id,
    playerName: player.name,
    score: player.seasonPoints,
    rank: index + 1,
  }))
  return { ranked, unrankedCount: total - ranked.length }
}

function assignTiers(ranked: RankedPlayer[], rules: SeasonRules): TierAssignment[] {
  return rules.rewardTiers
    .map((tier) => ({
      tier,
      players: ranked.filter((p) => p.rank >= tier.fromRank && p.rank <= tier.toRank),
    }))
    .filter((assignment) => assignment.players.length > 0)
}

/**
 * The full reset, inside the CALLER's transaction. `dryRun` skips only the
 * settledAt claim and the audit row — every other write executes and (for a
 * simulation) is rolled back by the wrapper.
 */
export async function executeSettlementInTx(
  tx: Tx,
  options: { dryRun: boolean; actorUserId?: string },
): Promise<SettlementReport> {
  const rules = seasonRulesOrThrow()
  const now = new Date()

  // 0) Resolve the clock state machine, then load the season to settle.
  await resolveSeasonStateInTx(tx, now)
  const latest = (await tx.season.findFirst({
    orderBy: { number: 'desc' },
  })) as SeasonRow | null
  if (!latest) throw new AppError('SEASON_NOT_FOUND', 'No season exists to settle')

  if (latest.endsAt.getTime() > now.getTime()) {
    throw new AppError('SETTLEMENT_NOT_PENDING', 'The current season has not ended yet')
  }
  if (latest.settledAt !== null) {
    throw new AppError('SEASON_ALREADY_SETTLED', 'This season has already been settled')
  }

  // 1) AT-MOST-ONCE claim: settledAt IS NULL → now. Concurrent executors
  //    converge on exactly one winner (count===1); the tx rolls back the
  //    loser entirely.
  if (!options.dryRun) {
    const claim = await tx.season.updateMany({
      where: { id: latest.id, settledAt: null },
      data: { settledAt: now, status: 'FINISHED' },
    })
    if (claim.count !== 1) {
      throw new AppError('SEASON_ALREADY_SETTLED', 'This season has already been settled')
    }
  }

  // 2) Final ranking from REAL season points (deterministic tie-break).
  const { ranked, unrankedCount } = await finalRanking(tx, rules)
  const tiered = assignTiers(ranked, rules)

  // 3) Materialize the immutable history (Leaderboard rows for every
  //    ranked player) — BigInt policy: scores stored as BigInt.
  if (ranked.length > 0) {
    await tx.leaderboard.createMany({
      data: ranked.map((row) => ({
        seasonId: latest.id,
        category: 'SEASON',
        period: 'SEASONAL',
        playerId: row.playerId,
        rank: row.rank,
        score: BigInt(row.score),
      })),
    })
  }

  // 4) Per-tier payouts: SeasonRewardClaim rows (resource payouts claimed
  //    idempotently later) + permanent-progression grants (already-owned
  //    rows are pre-filtered and never re-granted — permanent progression is
  //    idempotent) + one notification per finisher.
  const claimRows: Prisma.SeasonRewardClaimCreateManyInput[] = []
  const notifications: Prisma.NotificationCreateManyInput[] = []
  const titleGrantRows: Prisma.PlayerTitleCreateManyInput[] = []
  const cosmeticGrantRows: Prisma.PlayerCosmeticCreateManyInput[] = []
  const achievementGrantRows: Prisma.PlayerAchievementCreateManyInput[] = []

  for (const { tier, players } of tiered) {
    for (const player of players) {
      claimRows.push({
        seasonId: latest.id,
        playerId: player.playerId,
        rank: player.rank,
        score: player.score,
        tierName: tier.name,
        rewards: tier.resources as unknown as Prisma.InputJsonValue,
      })
      notifications.push({
        playerId: player.playerId,
        type: 'REWARD',
        title: `Season ${latest.number} finished — rank #${player.rank}`,
        body: `${tier.name}: your reward is ready to claim.`,
        data: { seasonId: latest.id, rank: player.rank } as Prisma.InputJsonValue,
      })
      for (const titleId of tier.titleIds) {
        titleGrantRows.push({
          playerId: player.playerId,
          titleId,
          acquiredSeason: latest.number,
        })
      }
      for (const cosmeticId of tier.cosmeticIds) {
        cosmeticGrantRows.push({
          playerId: player.playerId,
          cosmeticId,
          acquiredSeason: latest.number,
        })
      }
      for (const achievementId of tier.achievementIds) {
        achievementGrantRows.push({ playerId: player.playerId, achievementId })
      }
    }
  }

  if (claimRows.length > 0) await tx.seasonRewardClaim.createMany({ data: claimRows })
  if (notifications.length > 0) await tx.notification.createMany({ data: notifications })

  // Permanent-progression grants: pre-filter already-owned pairs, insert only
  // the missing ones — idempotent by construction (re-settlement can never
  // duplicate a title/cosmetic/achievement).
  const granteeIds = [...new Set(tiered.flatMap(({ players }) => players.map((p) => p.playerId)))]

  const titleWanted = new Set(titleGrantRows.map((row) => `${row.playerId}\u0000${row.titleId}`))
  if (titleWanted.size > 0) {
    const ownedTitles = await tx.playerTitle.findMany({
      where: { playerId: { in: granteeIds }, titleId: { in: titleGrantRows.map((row) => row.titleId) } },
      select: { playerId: true, titleId: true },
    })
    for (const row of ownedTitles) titleWanted.delete(`${row.playerId}\u0000${row.titleId}`)
  }
  const titlesGranted =
    titleWanted.size > 0
      ? (
          await tx.playerTitle.createMany({
            data: titleGrantRows.filter((row) => titleWanted.has(`${row.playerId}\u0000${row.titleId}`)),
          })
        ).count
      : 0

  const cosmeticWanted = new Set(
    cosmeticGrantRows.map((row) => `${row.playerId}\u0000${row.cosmeticId}`),
  )
  if (cosmeticWanted.size > 0) {
    const ownedCosmetics = await tx.playerCosmetic.findMany({
      where: {
        playerId: { in: granteeIds },
        cosmeticId: { in: cosmeticGrantRows.map((row) => row.cosmeticId) },
      },
      select: { playerId: true, cosmeticId: true },
    })
    for (const row of ownedCosmetics) cosmeticWanted.delete(`${row.playerId}\u0000${row.cosmeticId}`)
  }
  const cosmeticsGranted =
    cosmeticWanted.size > 0
      ? (
          await tx.playerCosmetic.createMany({
            data: cosmeticGrantRows.filter((row) =>
              cosmeticWanted.has(`${row.playerId}\u0000${row.cosmeticId}`),
            ),
          })
        ).count
      : 0

  const achievementWanted = new Set(
    achievementGrantRows.map((row) => `${row.playerId}\u0000${row.achievementId}`),
  )
  if (achievementWanted.size > 0) {
    const ownedAchievements = await tx.playerAchievement.findMany({
      where: {
        playerId: { in: granteeIds },
        achievementId: { in: achievementGrantRows.map((row) => row.achievementId) },
      },
      select: { playerId: true, achievementId: true },
    })
    for (const row of ownedAchievements)
      achievementWanted.delete(`${row.playerId}\u0000${row.achievementId}`)
  }
  const achievementsGranted =
    achievementWanted.size > 0
      ? (
          await tx.playerAchievement.createMany({
            data: achievementGrantRows.filter((row) =>
              achievementWanted.has(`${row.playerId}\u0000${row.achievementId}`),
            ),
          })
        ).count
      : 0

  // 5) THE SEASONAL WIPE — walks the data-driven reset catalog. Permanent
  //    progression tables are NEVER touched (the tests assert their counts
  //    are byte-identical across the settlement).
  const wipe = {
    seasonPointsReset: 0,
    territoriesStripped: 0,
    seasonWalletsDeleted: 0,
    seasonalCommandersDeleted: 0,
  }
  for (const action of SEASONAL_RESET_CATALOG) {
    switch (action) {
      case 'PLAYER_SEASON_POINTS': {
        const result = await tx.player.updateMany({ data: { seasonPoints: 0 } })
        wipe.seasonPointsReset = result.count
        break
      }
      case 'TERRITORY_OWNERSHIP': {
        const result = await tx.territory.updateMany({
          where: { ownerPlayerId: { not: null } },
          data: { ownerPlayerId: null, lastCapturedAt: null },
        })
        wipe.territoriesStripped = result.count
        break
      }
      case 'SEASON_WALLETS': {
        const result = await tx.seasonWallet.deleteMany({ where: { seasonId: latest.id } })
        wipe.seasonWalletsDeleted = result.count
        break
      }
      case 'SEASONAL_COMMANDERS': {
        const result = await tx.playerCommander.deleteMany({
          where: { commander: { isSeasonal: true } },
        })
        wipe.seasonalCommandersDeleted = result.count
        break
      }
    }
  }

  // 6) Create the next season (rules snapshot at creation time).
  const nextNumber = latest.number + 1
  const startsAt = now
  const endsAt = new Date(startsAt.getTime() + rules.durationDays * 24 * 3600 * 1000)
  const nextSeason = await tx.season.create({
    data: {
      number: nextNumber,
      name: rules.namePattern.replace('{n}', String(nextNumber)),
      startsAt,
      endsAt,
      status: 'ACTIVE',
      config: rules as unknown as Prisma.InputJsonValue,
    },
  })

  // 7) Audit trail (real settlements only — simulations persist nothing).
  if (!options.dryRun && options.actorUserId) {
    await tx.auditLog.create({
      data: {
        actorUserId: options.actorUserId,
        action: 'SEASON_SETTLE',
        targetType: 'season',
        targetId: latest.id,
        after: {
          seasonNumber: latest.number,
          rankedPlayers: ranked.length,
          nextSeasonNumber: nextNumber,
          wipe,
        } as unknown as Prisma.InputJsonValue,
      },
    })
  }

  const report: SettlementReport = {
    dryRun: options.dryRun,
    settledSeason: {
      id: latest.id,
      number: latest.number,
      name: latest.name,
      startedAt: latest.startsAt.toISOString(),
      endedAt: latest.endsAt.toISOString(),
    },
    rankedPlayers: ranked.length,
    unrankedPlayers: unrankedCount,
    tiers: tiered.map(({ tier, players }) => ({
      tierName: tier.name,
      fromRank: tier.fromRank,
      toRank: tier.toRank,
      players: players.length,
      resources: tier.resources,
      titles: tier.titleIds,
      cosmetics: tier.cosmeticIds,
      achievements: tier.achievementIds,
    })),
    wipe,
    grants: {
      titlesGranted,
      cosmeticsGranted,
      achievementsGranted,
      notificationsCreated: notifications.length,
    },
    nextSeason: {
      number: nextSeason.number,
      name: nextSeason.name,
      startsAt: nextSeason.startsAt.toISOString(),
      endsAt: nextSeason.endsAt.toISOString(),
    },
  }

  log.info('season settlement executed', {
    dryRun: options.dryRun,
    seasonNumber: latest.number,
    rankedPlayers: ranked.length,
  })
  return report
}

// ── Public operations ────────────────────────────────────────────────────────

/** Internal rollback marker carrying the simulation report. */
class SettlementSimulated extends Error {
  readonly report: SettlementReport
  constructor(report: SettlementReport) {
    super('settlement simulation complete — transaction rolled back')
    this.name = 'SettlementSimulated'
    this.report = report
  }
}

/**
 * DRY-RUN reset: the identical settlement code path executes inside a
 * transaction that is ALWAYS rolled back. Returns what WOULD happen.
 * No partial state can ever persist — the rollback is unconditional.
 */
export async function simulateSeasonSettlement(): Promise<SettlementReport> {
  try {
    return await db.$transaction(
      async (tx) => {
        const report = await executeSettlementInTx(tx, { dryRun: true })
        throw new SettlementSimulated(report)
      },
      ECONOMY_TX_OPTIONS,
    )
  } catch (err) {
    if (err instanceof SettlementSimulated) return err.report
    throw err
  }
}

/**
 * The REAL reset. Admin-only (route layer enforces), audited, at-most-once.
 * Creates the next season as part of the same transaction.
 */
export async function settleSeason(actorUserId: string): Promise<SettlementReport> {
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Settlement requires an authenticated actor')
  }
  return db.$transaction(
    (tx) => executeSettlementInTx(tx, { dryRun: false, actorUserId }),
    ECONOMY_TX_OPTIONS,
  )
}
