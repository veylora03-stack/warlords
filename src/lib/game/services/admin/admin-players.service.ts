/**
 * WARLORDS — Admin player management service (Phase 21).
 *
 * Search · full inspection · ban · unban. Ban enforcement is NOT here —
 * it is the session service's `assertNotBanned`, which runs on EVERY
 * authenticated request (DB is the authority per request). This module
 * only flips the authoritative flag, transactionally and audited.
 */

import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { ECONOMY_RESOURCES } from '@/lib/game/config/economy'
import { ADMIN_PANEL_POLICY } from '@/lib/game/config/admin'
import { getWalletBalances } from '../economy.service'
import { recordAdminAuditInTx, recordAdminAuditView } from './admin-audit.service'

// ── Search ───────────────────────────────────────────────────────────────────

export interface AdminPlayerSummary {
  id: string
  name: string
  level: number
  power: string
  seasonPoints: number
  clanId: string | null
  clanName: string | null
  createdAt: string
  user: { userId: string; telegramId: string; username: string | null; isBanned: boolean }
}

export interface AdminPlayerSearchResult {
  query: string | null
  rows: AdminPlayerSummary[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export async function searchPlayers(input: {
  q?: string
  page: number
  pageSize: number
  actorUserId: string
  ip?: string
}): Promise<AdminPlayerSearchResult> {
  const q = input.q?.trim() ?? ''
  const where = q
    ? {
        OR: [
          { name: { contains: q } },
          { id: q },
          { user: { is: { telegramId: q } } },
          { user: { is: { username: { contains: q } } } },
        ],
      }
    : {}

  const [total, rows] = await Promise.all([
    db.player.count({ where }),
    db.player.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        user: { select: { id: true, telegramId: true, username: true, isBanned: true } },
        clan: { select: { name: true } },
      },
    }),
  ])

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_PLAYERS_SEARCH',
    targetType: 'player',
    reason: q ? `search "${q.slice(0, 64)}" → ${total}` : `list page ${input.page} → ${total}`,
    ip: input.ip,
  })

  return {
    query: q || null,
    rows: rows.map(toSummary),
    page: input.page,
    pageSize: input.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / input.pageSize)),
  }
}

function toSummary(row: {
  id: string
  name: string
  level: number
  power: bigint
  seasonPoints: number
  clanId: string | null
  clanName?: string | null
  createdAt: Date
  user: { id: string; telegramId: string; username: string | null; isBanned: boolean }
}): AdminPlayerSummary {
  return {
    id: row.id,
    name: row.name,
    level: row.level,
    power: row.power.toString(),
    seasonPoints: row.seasonPoints,
    clanId: row.clanId,
    clanName: row.clanName ?? null,
    createdAt: row.createdAt.toISOString(),
    user: {
      userId: row.user.id,
      telegramId: row.user.telegramId,
      username: row.user.username,
      isBanned: row.user.isBanned,
    },
  }
}

// ── Details (full inspection) ────────────────────────────────────────────────

export interface AdminPlayerDetails {
  id: string
  name: string
  level: number
  xp: string
  power: string
  honor: string
  reputation: string
  gems: string
  energy: number
  seasonPoints: number
  clan: { id: string; name: string; role: string | null } | null
  title: { id: string; name: string } | null
  createdAt: string
  user: {
    userId: string
    telegramId: string
    username: string | null
    role: string
    isBanned: boolean
    banReason: string | null
    bannedAt: string | null
    banExpiresAt: string | null
    lastLoginAt: string | null
  }
  wallet: Record<string, string>
  city: {
    id: string
    name: string
    x: number
    y: number
    buildings: number
    townHallLevel: number | null
  } | null
  army: { unitCount: number; topTier: number | null }
  ledgerTail: Array<{
    id: string
    resource: string
    delta: string
    balanceAfter: string
    reason: string
    createdAt: string
  }>
  battlesTail: Array<{
    id: string
    type: string
    result: string
    attackerPlayerId: string
    defenderPlayerId: string | null
    startedAt: string
  }>
}

export async function getPlayerDetails(input: {
  playerId: string
  actorUserId: string
  ip?: string
}): Promise<AdminPlayerDetails> {
  const player = await db.player.findUnique({
    where: { id: input.playerId },
    include: {
      user: true,
      clan: { select: { id: true, name: true } },
      activeTitle: { select: { id: true, name: true } },
      city: {
        include: { buildings: { select: { type: true, level: true } } },
      },
      units: { select: { count: true, unit: { select: { tier: true } } } },
    },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const [wallet, ledgerTail, battlesTail] = await Promise.all([
    getWalletBalances(db, player.id),
    db.resourceTransaction.findMany({
      where: { playerId: player.id },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_PANEL_POLICY.ledgerTailRows,
    }),
    db.battle.findMany({
      where: { OR: [{ attackerPlayerId: player.id }, { defenderPlayerId: player.id }] },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_PANEL_POLICY.battleTailRows,
    }),
  ])

  const townHall = player.city?.buildings.find((b) => b.type === 'TOWN_HALL') ?? null

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_PLAYER_DETAILS',
    targetType: 'player',
    targetId: player.id,
    ip: input.ip,
  })

  return {
    id: player.id,
    name: player.name,
    level: player.level,
    xp: player.xp.toString(),
    power: player.power.toString(),
    honor: player.honor.toString(),
    reputation: player.reputation,
    gems: player.gems.toString(),
    energy: player.energy,
    seasonPoints: player.seasonPoints,
    clan: player.clan
      ? { id: player.clan.id, name: player.clan.name, role: player.clanRole }
      : null,
    title: player.activeTitle ? { id: player.activeTitle.id, name: player.activeTitle.name } : null,
    createdAt: player.createdAt.toISOString(),
    user: {
      userId: player.user.id,
      telegramId: player.user.telegramId,
      username: player.user.username,
      role: player.user.role,
      isBanned: player.user.isBanned,
      banReason: player.user.banReason,
      bannedAt: player.user.bannedAt?.toISOString() ?? null,
      banExpiresAt: player.user.banExpiresAt?.toISOString() ?? null,
      lastLoginAt: player.user.lastLoginAt?.toISOString() ?? null,
    },
    wallet: Object.fromEntries(
      ECONOMY_RESOURCES.map((resource) => [resource, (wallet[resource] ?? 0n).toString()]),
    ),
    city: player.city
      ? {
          id: player.city.id,
          name: player.city.name,
          x: player.city.x,
          y: player.city.y,
          buildings: player.city.buildings.length,
          townHallLevel: townHall?.level ?? null,
        }
      : null,
    army: {
      unitCount: player.units.reduce((sum, stack) => sum + stack.count, 0),
      topTier: player.units.reduce<number | null>(
        (top, stack) => (top === null || stack.unit.tier > top ? stack.unit.tier : top),
        null,
      ),
    },
    ledgerTail: ledgerTail.map((row) => ({
      id: row.id,
      resource: row.resource,
      delta: row.delta.toString(),
      balanceAfter: row.balanceAfter.toString(),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    battlesTail: battlesTail.map((battle) => ({
      id: battle.id,
      type: battle.type,
      result: battle.result,
      attackerPlayerId: battle.attackerPlayerId,
      defenderPlayerId: battle.defenderPlayerId,
      startedAt: battle.startedAt.toISOString(),
    })),
  }
}

// ── Ban / Unban ──────────────────────────────────────────────────────────────

export interface BanPlayerInput {
  playerId: string
  actorUserId: string
  reason: string
  /** Optional temporary ban horizon — omitted = permanent until unban. */
  expiresAt?: Date
  ip?: string
}

export interface BanPlayerResult {
  playerId: string
  userId: string
  isBanned: true
  banReason: string
  bannedAt: string
  banExpiresAt: string | null
}

function assertReason(reason: unknown): string {
  if (
    typeof reason !== 'string' ||
    reason.trim().length < ADMIN_PANEL_POLICY.banReasonMinLength ||
    reason.trim().length > ADMIN_PANEL_POLICY.banReasonMaxLength
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Ban reason is required (${ADMIN_PANEL_POLICY.banReasonMinLength}…${ADMIN_PANEL_POLICY.banReasonMaxLength} chars)`,
    )
  }
  return reason.trim()
}

/**
 * Bans the player's USER account — every authenticated request then 403s.
 *
 * SECURITY (Phase 23): staff accounts are NOT bannable through this path.
 * Ban enforcement runs on EVERY authenticated request, so banning a
 * player that belongs to an active staff member would lock that staff
 * member out of the admin panel — including `players.unban` — i.e. a
 * MODERATOR could escalate against an ADMIN (and against themself).
 * Staff access is revoked exclusively through `staff.deactivate`
 * (staff.manage scope, self-target guarded). The actor also cannot ban
 * themself. Both refusals are typed 403s, before any write.
 */
export async function banPlayer(input: BanPlayerInput): Promise<BanPlayerResult> {
  const reason = assertReason(input.reason)
  const now = new Date()

  return dbWrite.$transaction(async (tx) => {
    const player = await tx.player.findUnique({
      where: { id: input.playerId },
      select: {
        id: true,
        name: true,
        user: {
          select: {
            id: true,
            isBanned: true,
            adminRecord: { select: { id: true, isActive: true } },
          },
        },
      },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    if (player.user.adminRecord?.isActive) {
      throw new AppError(
        'PROTECTED_TARGET',
        'Staff accounts cannot be banned — deactivate staff access instead',
      )
    }
    if (player.user.id === input.actorUserId) {
      throw new AppError('SELF_TARGET', 'You cannot ban your own account')
    }
    if (player.user.isBanned) {
      throw new AppError('PLAYER_ALREADY_BANNED', 'This player is already banned')
    }

    // Conditional claim — a concurrent ban converges on exactly one winner.
    const claim = await tx.user.updateMany({
      where: { id: player.user.id, isBanned: false },
      data: {
        isBanned: true,
        banReason: reason,
        bannedAt: now,
        banExpiresAt: input.expiresAt ?? null,
      },
    })
    if (claim.count !== 1) {
      throw new AppError('PLAYER_ALREADY_BANNED', 'This player is already banned')
    }

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'BAN',
      targetType: 'player',
      targetId: player.id,
      before: { userId: player.user.id, isBanned: false },
      after: {
        userId: player.user.id,
        isBanned: true,
        reason,
        banExpiresAt: input.expiresAt?.toISOString() ?? null,
      },
      reason,
      ip: input.ip,
    })

    return {
      playerId: player.id,
      userId: player.user.id,
      isBanned: true,
      banReason: reason,
      bannedAt: now.toISOString(),
      banExpiresAt: input.expiresAt?.toISOString() ?? null,
    }
  })
}

export interface UnbanPlayerResult {
  playerId: string
  userId: string
  isBanned: false
}

export async function unbanPlayer(input: {
  playerId: string
  actorUserId: string
  note?: string
  ip?: string
}): Promise<UnbanPlayerResult> {
  const note = input.note?.trim() || null

  return dbWrite.$transaction(async (tx) => {
    const player = await tx.player.findUnique({
      where: { id: input.playerId },
      select: { id: true, name: true, user: { select: { id: true, isBanned: true } } },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    if (!player.user.isBanned) {
      throw new AppError('PLAYER_NOT_BANNED', 'This player is not banned')
    }

    const claim = await tx.user.updateMany({
      where: { id: player.user.id, isBanned: true },
      data: { isBanned: false, banReason: null, bannedAt: null, banExpiresAt: null },
    })
    if (claim.count !== 1) {
      throw new AppError('PLAYER_NOT_BANNED', 'This player is not banned')
    }

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'UNBAN',
      targetType: 'player',
      targetId: player.id,
      before: { userId: player.user.id, isBanned: true },
      after: { userId: player.user.id, isBanned: false },
      reason: note ?? undefined,
      ip: input.ip,
    })

    return { playerId: player.id, userId: player.user.id, isBanned: false }
  })
}
