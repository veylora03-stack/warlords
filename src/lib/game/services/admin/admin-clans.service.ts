/**
 * WARLORDS — Admin clan management service (Phase 21).
 *
 * Inspect (read-only) + disband (destructive, typed-confirmation, audited).
 * Disband walks the REAL relation graph inside one transaction: members are
 * removed, the denormalized player fields are cleared, dependent rows are
 * deleted, and a clan with live war rows is REFUSED (CLAN_HAS_WARS) — the
 * war history is Restrict-protected and must never be orphaned.
 */

import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { ADMIN_CONFIRMATIONS } from '@/lib/game/config/admin'
import { recordAdminAuditInTx, recordAdminAuditView, type Paginated } from './admin-audit.service'

export interface AdminClanRow {
  id: string
  name: string
  tag: string
  leaderPlayerId: string
  leaderName: string | null
  level: number
  memberCount: number
  trophies: number
  createdAt: string
}

export type AdminClanListResult = Paginated<AdminClanRow>

export async function listClans(input: {
  q?: string
  page: number
  pageSize: number
  actorUserId: string
  ip?: string
}): Promise<AdminClanListResult> {
  const q = input.q?.trim() ?? ''
  const where = q ? { OR: [{ name: { contains: q } }, { tag: { contains: q } }] } : {}
  const [total, rows] = await Promise.all([
    db.clan.count({ where }),
    db.clan.findMany({
      where,
      orderBy: [{ trophies: 'desc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: { leader: { select: { name: true } } },
    }),
  ])
  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_CLANS',
    targetType: 'clan',
    reason: `list page ${input.page} → ${total}`,
    ip: input.ip,
  })
  return {
    rows: rows.map((clan) => ({
      id: clan.id,
      name: clan.name,
      tag: clan.tag,
      leaderPlayerId: clan.leaderPlayerId,
      leaderName: clan.leader.name,
      level: clan.level,
      memberCount: clan.memberCount,
      trophies: clan.trophies,
      createdAt: clan.createdAt.toISOString(),
    })),
    page: input.page,
    pageSize: input.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / input.pageSize)),
  }
}

export interface AdminClanDetail extends AdminClanRow {
  description: string | null
  settings: unknown
  treasury: unknown
  members: Array<{
    playerId: string
    name: string
    role: string
    contribution: number
    joinedAt: string
  }>
}

export async function getClanDetail(input: {
  clanId: string
  actorUserId: string
  ip?: string
}): Promise<AdminClanDetail> {
  const clan = await db.clan.findUnique({
    where: { id: input.clanId },
    include: {
      leader: { select: { name: true } },
      members: {
        orderBy: { joinedAt: 'asc' },
        include: { player: { select: { name: true } } },
      },
    },
  })
  if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_CLAN_DETAIL',
    targetType: 'clan',
    targetId: clan.id,
    ip: input.ip,
  })

  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    leaderPlayerId: clan.leaderPlayerId,
    leaderName: clan.leader.name,
    level: clan.level,
    memberCount: clan.memberCount,
    trophies: clan.trophies,
    createdAt: clan.createdAt.toISOString(),
    description: clan.description,
    settings: clan.settings,
    treasury: clan.treasury,
    members: clan.members.map((member) => ({
      playerId: member.playerId,
      name: member.player.name,
      role: member.role,
      contribution: member.contribution,
      joinedAt: member.joinedAt.toISOString(),
    })),
  }
}

export interface DisbandClanResult {
  clanId: string
  name: string
  membersRemoved: number
}

export async function disbandClan(input: {
  clanId: string
  actorUserId: string
  confirm: string
  reason: string
  ip?: string
}): Promise<DisbandClanResult> {
  // Typed confirmation phrase — validated SERVER-side (safety rail).
  if (input.confirm !== ADMIN_CONFIRMATIONS.clanDisband) {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      `Type "${ADMIN_CONFIRMATIONS.clanDisband}" to confirm the disband`,
    )
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length < 4) {
    throw new AppError('VALIDATION_ERROR', 'Disband requires a reason (4+ chars)')
  }

  return dbWrite.$transaction(async (tx) => {
    const clan = await tx.clan.findUnique({
      where: { id: input.clanId },
      include: { members: { select: { playerId: true } } },
    })
    if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')

    const warCount = await tx.clanWar.count({
      where: { OR: [{ attackerClanId: clan.id }, { defenderClanId: clan.id }] },
    })
    if (warCount > 0) {
      throw new AppError(
        'CLAN_HAS_WARS',
        'This clan has war history — resolve the wars before disbanding',
        { wars: warCount },
      )
    }

    // Snapshot for the audit row BEFORE anything is deleted.
    const snapshot = {
      id: clan.id,
      name: clan.name,
      tag: clan.tag,
      leaderPlayerId: clan.leaderPlayerId,
      memberCount: clan.memberCount,
      members: clan.members.map((m) => m.playerId),
    }

    // Dependents first (invitation/message rows are clan-scoped), then the
    // denormalized player fields, then members, then the clan itself.
    await tx.clanInvitation.deleteMany({ where: { clanId: clan.id } })
    await tx.clanMessage.deleteMany({ where: { clanId: clan.id } })
    await tx.player.updateMany({
      where: { id: { in: snapshot.members } },
      data: { clanId: null, clanRole: null },
    })
    await tx.clanMember.deleteMany({ where: { clanId: clan.id } })
    await tx.clan.delete({ where: { id: clan.id } })

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'CLAN_DISBAND',
      targetType: 'clan',
      targetId: clan.id,
      before: snapshot,
      after: null,
      reason: input.reason.trim(),
      ip: input.ip,
    })

    return {
      clanId: clan.id,
      name: clan.name,
      membersRemoved: snapshot.members.length,
    }
  })
}
