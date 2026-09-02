/**
 * WARLORDS — Clan service (Phase 34: Clans & Positional Territory Garrisons).
 *
 * Implements the Phase 2 CONTRACT models (Clan / ClanMember / ClanInvitation)
 * as a real, server-authoritative domain. NOTHING here is client-writable:
 * membership, roles and authorization are resolved from the database inside
 * the mutating transaction (NEVER TRUST THE CLIENT).
 *
 * Domain rules (single source of truth — unit/integration-tested):
 *  - EXACTLY ONE clan per player (ClanMember.playerId @unique + denormalized
 *    Player.clanId/clanRole kept in sync IN-TX — the denormalization is a
 *    mirror, never a second authority).
 *  - EXACTLY ONE LEADER per clan: Clan.leaderPlayerId is the authority and
 *    the ClanMember.role row mirrors it. Leadership transfer swaps both.
 *  - Role matrix: OFFICER+ invite and remove MEMBERs; only the LEADER sets
 *    roles and transfers leadership; nobody manages an equal/higher rank;
 *    the leader cannot leave without transferring (succession rule).
 *  - Join: OPEN clans accept direct joins; INVITE_ONLY clans require a
 *    PENDING, unexpired invitation claimed by the joiner (state-guarded).
 *  - Every mutation is transactional, replay-guarded by state (a replayed
 *    leave/join lands on a typed 409) and lock-ordered clan:engine → db:write.
 *
 * Economy note: clan creation/joining is intentionally FREE (no ledger
 * side-effects) — clan treasury/war economies are NOT in Phase 34 scope and
 * are honestly documented as future work (docs/CLANS-GARRISONS.md).
 */

import { Prisma } from '@prisma/client'
import { dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import { CLAN, CLAN_ROLE_RANKS, type ClanJoinPolicy } from '@/lib/game/config/clan'
import { recordPlayerStats } from './stats.service'
import { applyQuestEventInTx } from './quest-events.service'
import { evaluateAchievementsInTx } from './achievement.service'
import { enqueueNotificationInTx, enqueueNotificationFanOutInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'

const log = logger.child({ module: 'game/clan' })

/** Process-wide clan serialization key (mirrors march:engine / battle:engine). */
export const CLAN_ENGINE_LOCK = 'clan:engine'

const CLAN_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

function runClanTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock(CLAN_ENGINE_LOCK, () =>
    withKeyLock('db:write', () => withWriteRetry(() => dbWrite.$transaction(run, CLAN_TX_OPTIONS))),
  )
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface ClanMemberView {
  playerId: string
  name: string
  role: 'LEADER' | 'OFFICER' | 'MEMBER'
  power: string
  level: number
  joinedAt: string
}

export interface ClanSummaryView {
  id: string
  name: string
  tag: string
  description: string | null
  leaderPlayerId: string
  leaderName: string
  memberCount: number
  maxMembers: number
  joinPolicy: ClanJoinPolicy
  trophies: number
  createdAt: string
}

export interface ClanDetailView extends ClanSummaryView {
  members: ClanMemberView[]
  viewerRole: 'LEADER' | 'OFFICER' | 'MEMBER' | null
  pendingInvitationCount: number
}

export interface ClanInvitationView {
  id: string
  clanId: string
  clanName: string
  clanTag: string
  invitorName: string
  createdAt: string
  expiresAt: string
}

export interface ClanListPage {
  clans: ClanSummaryView[]
  page: number
  pageSize: number
  total: number
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Resolves the clan's join policy from its settings JSON (defensive). */
export function joinPolicyOf(settings: unknown): ClanJoinPolicy {
  if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
    const policy = (settings as { joinPolicy?: unknown }).joinPolicy
    if (typeof policy === 'string' && (CLAN.joinPolicies as readonly string[]).includes(policy)) {
      return policy as ClanJoinPolicy
    }
  }
  return CLAN.defaultJoinPolicy
}

/** Role rank lookup with fail-closed default (unknown role ranks lowest). */
export function roleRank(role: string): number {
  return CLAN_ROLE_RANKS[role as keyof typeof CLAN_ROLE_RANKS] ?? 0
}

function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'tag must be a string')
  }
  const tag = raw.trim().toUpperCase()
  if (tag.length < CLAN.tagMinLength || tag.length > CLAN.tagMaxLength) {
    throw new AppError(
      'VALIDATION_ERROR',
      `tag must be ${CLAN.tagMinLength}–${CLAN.tagMaxLength} characters`,
    )
  }
  if (!/^[A-Z0-9]+$/.test(tag)) {
    throw new AppError('VALIDATION_ERROR', 'tag must use only letters and digits')
  }
  return tag
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'name must be a string')
  }
  const name = raw.trim()
  if (name.length < CLAN.nameMinLength || name.length > CLAN.nameMaxLength) {
    throw new AppError(
      'VALIDATION_ERROR',
      `name must be ${CLAN.nameMinLength}–${CLAN.nameMaxLength} characters`,
    )
  }
  return name
}

// ── View builders ────────────────────────────────────────────────────────────

function summaryView(
  clan: {
    id: string
    name: string
    tag: string
    description: string | null
    leaderPlayerId: string
    memberCount: number
    trophies: number
    settings: unknown
    createdAt: Date
    leader: { name: string } | null
  },
  maxMembers: number = CLAN.maxMembers,
): ClanSummaryView {
  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    description: clan.description,
    leaderPlayerId: clan.leaderPlayerId,
    leaderName: clan.leader?.name ?? '—',
    memberCount: clan.memberCount,
    maxMembers,
    joinPolicy: joinPolicyOf(clan.settings),
    trophies: clan.trophies,
    createdAt: clan.createdAt.toISOString(),
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface CreateClanInput {
  name: unknown
  tag: unknown
  description?: unknown
  joinPolicy?: unknown
}

export async function createClan(
  playerId: string,
  input: CreateClanInput,
): Promise<ClanDetailView> {
  // Zero-write validation.
  const name = normalizeName(input.name)
  const tag = normalizeTag(input.tag)
  let description: string | null = null
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string' || input.description.trim().length > 200) {
      throw new AppError('VALIDATION_ERROR', 'description must be a string of at most 200 chars')
    }
    description = input.description.trim() || null
  }
  let joinPolicy = CLAN.defaultJoinPolicy
  if (input.joinPolicy !== undefined) {
    if (
      typeof input.joinPolicy !== 'string' ||
      !(CLAN.joinPolicies as readonly string[]).includes(input.joinPolicy)
    ) {
      throw new AppError('VALIDATION_ERROR', 'joinPolicy must be OPEN or INVITE_ONLY')
    }
    joinPolicy = input.joinPolicy as ClanJoinPolicy
  }
  const now = new Date()

  return runClanTransaction(async (tx) => {
    const player = await tx.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, clanId: true, clanRole: true },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    if (player.clanId) throw new AppError('ALREADY_IN_CLAN', 'You are already in a clan')

    // Unique-name/tag collisions surface as typed 409s (P2002 below).
    let clan
    try {
      clan = await tx.clan.create({
        data: {
          name,
          tag,
          description,
          leaderPlayerId: playerId,
          memberCount: 1,
          settings: { joinPolicy } as unknown as Prisma.InputJsonValue,
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = err.meta?.target
        const fields = Array.isArray(target) ? target.join(',') : String(target ?? '')
        if (fields.includes('tag')) {
          throw new AppError('CLAN_TAG_TAKEN', 'That clan tag is already taken')
        }
        throw new AppError('CLAN_NAME_TAKEN', 'That clan name is already taken')
      }
      throw err
    }

    await tx.clanMember.create({
      data: { clanId: clan.id, playerId, role: 'LEADER', joinedAt: now },
    })
    await tx.player.update({
      where: { id: playerId },
      data: { clanId: clan.id, clanRole: 'LEADER' },
    })

    // The founder has effectively "joined" their own banner.
    await recordPlayerStats(tx, playerId, { clansJoined: 1 })
    await applyQuestEventInTx(
      tx,
      playerId,
      { kind: 'CLAN_CREATED', clanId: clan.id, clanName: clan.name },
      now,
    )
    await applyQuestEventInTx(
      tx,
      playerId,
      { kind: 'CLAN_JOINED', clanId: clan.id, clanName: clan.name },
      now,
    )
    await evaluateAchievementsInTx(tx, playerId, {}, now)

    log.info('clan created', { clanId: clan.id, playerId, tag })
    return getClanDetailInTx(tx, clan.id, playerId)
  })
}

export async function joinClan(
  playerId: string,
  clanId: string,
  invitationId?: string,
): Promise<ClanDetailView> {
  const now = new Date()
  return runClanTransaction(async (tx) => {
    const player = await tx.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, clanId: true },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    if (player.clanId) throw new AppError('ALREADY_IN_CLAN', 'You are already in a clan')

    const clan = await tx.clan.findUnique({ where: { id: clanId } })
    if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')

    const policy = joinPolicyOf(clan.settings)
    if (clan.memberCount >= CLAN.maxMembers) {
      throw new AppError('CLAN_FULL', 'This clan is full', { maxMembers: CLAN.maxMembers })
    }

    if (policy === 'INVITE_ONLY') {
      if (!invitationId) {
        throw new AppError('CLAN_JOIN_POLICY_CLOSED', 'This clan is invite-only')
      }
      const invitation = await tx.clanInvitation.findUnique({ where: { id: invitationId } })
      const valid =
        invitation &&
        invitation.clanId === clanId &&
        invitation.playerId === playerId &&
        invitation.status === 'PENDING' &&
        invitation.expiresAt.getTime() > now.getTime()
      if (!valid) {
        throw new AppError('CLAN_INVITATION_INVALID', 'No valid invitation for this clan')
      }
      // Claim the invitation exactly once (state-guarded CAS).
      const claim = await tx.clanInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ACCEPTED' },
      })
      if (claim.count !== 1) {
        throw new AppError('CLAN_INVITATION_INVALID', 'Invitation was already used')
      }
    }
    // An invitation id on an OPEN clan is simply ignored — the join itself is
    // the authorization (documented, honest policy).

    await tx.clanMember.create({
      data: { clanId: clan.id, playerId, role: 'MEMBER', joinedAt: now },
    })
    await tx.clan.update({
      where: { id: clan.id },
      data: { memberCount: { increment: 1 } },
    })
    await tx.player.update({
      where: { id: playerId },
      data: { clanId: clan.id, clanRole: 'MEMBER' },
    })

    await recordPlayerStats(tx, playerId, { clansJoined: 1 })
    await applyQuestEventInTx(
      tx,
      playerId,
      { kind: 'CLAN_JOINED', clanId: clan.id, clanName: clan.name },
      now,
    )
    await evaluateAchievementsInTx(tx, playerId, {}, now)
    await enqueueNotificationInTx(tx, {
      playerId: clan.leaderPlayerId,
      type: 'CLAN_JOINED',
      dedupeKey: notificationDedupeKeys.clanJoined(clan.id, playerId),
      payload: {
        clanId: clan.id,
        clanName: clan.name,
        memberName: player.name ?? 'A warlord',
        memberCount: clan.memberCount + 1,
      },
    })

    log.info('clan joined', { clanId: clan.id, playerId, policy })
    return getClanDetailInTx(tx, clan.id, playerId)
  })
}

export async function leaveClan(
  playerId: string,
  expectedClanId?: string,
): Promise<{ leftClanId: string }> {
  return runClanTransaction(async (tx) => {
    const member = await tx.clanMember.findUnique({
      where: { playerId },
      include: {
        clan: { select: { id: true, name: true, leaderPlayerId: true, memberCount: true } },
      },
    })
    if (!member) throw new AppError('NOT_IN_CLAN', 'You are not in a clan')
    if (expectedClanId !== undefined && member.clanId !== expectedClanId) {
      // Path/id mismatch is a typed refusal — never a partial write.
      throw new AppError('NOT_IN_CLAN', 'You are not in this clan')
    }
    if (member.clan.leaderPlayerId === playerId) {
      // Succession rule: the leader must transfer the banner first — a clan
      // can never be left leaderless (its garrisons would lose authority).
      throw new AppError('CLAN_LEADER_SUCCESSION', 'Transfer leadership before leaving your clan')
    }
    await tx.clanMember.delete({ where: { id: member.id } })
    await tx.clan.update({
      where: { id: member.clanId },
      data: { memberCount: { decrement: 1 } },
    })
    await tx.player.update({
      where: { id: playerId },
      data: { clanId: null, clanRole: null },
    })
    log.info('clan left', { clanId: member.clanId, playerId })
    return { leftClanId: member.clanId }
  })
}

export async function inviteMember(
  actorPlayerId: string,
  clanId: string,
  targetPlayerId: string,
): Promise<ClanInvitationView> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CLAN.invitationTtlHours * 3_600_000)
  return runClanTransaction(async (tx) => {
    const actor = await tx.clanMember.findUnique({
      where: { playerId: actorPlayerId },
      select: { role: true, clanId: true, clan: { select: { id: true, name: true, tag: true } } },
    })
    if (!actor || actor.clanId !== clanId)
      throw new AppError('NOT_IN_CLAN', 'You are not in this clan')
    if (roleRank(actor.role) < roleRank('OFFICER')) {
      throw new AppError('CLAN_ROLE_REQUIRED', 'Only the leader or an officer can invite')
    }
    if (actorPlayerId === targetPlayerId) {
      throw new AppError('VALIDATION_ERROR', 'You are already a member of your own clan')
    }
    const target = await tx.player.findUnique({
      where: { id: targetPlayerId },
      select: { id: true, name: true, clanId: true },
    })
    if (!target) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    if (target.clanId) throw new AppError('ALREADY_IN_CLAN', 'That player is already in a clan')

    const clan = await tx.clan.findUnique({ where: { id: clanId }, select: { memberCount: true } })
    if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')
    if (clan.memberCount >= CLAN.maxMembers) {
      throw new AppError('CLAN_FULL', 'This clan is full', { maxMembers: CLAN.maxMembers })
    }

    // One PENDING invitation per (clan, player) at a time — replace lifecycle:
    // an existing PENDING invite is superseded instead of duplicated.
    const existing = await tx.clanInvitation.findFirst({
      where: { clanId, playerId: targetPlayerId, status: 'PENDING', expiresAt: { gt: now } },
      select: { id: true },
    })
    if (existing) {
      await tx.clanInvitation.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
      })
    }

    const invitor = await tx.player.findUnique({
      where: { id: actorPlayerId },
      select: { name: true },
    })
    const invitation = await tx.clanInvitation.create({
      data: {
        clanId,
        playerId: targetPlayerId,
        invitedById: actorPlayerId,
        status: 'PENDING',
        expiresAt,
      },
    })
    await enqueueNotificationInTx(tx, {
      playerId: targetPlayerId,
      type: 'CLAN_INVITE',
      dedupeKey: notificationDedupeKeys.clanInvite(invitation.id),
      payload: {
        invitationId: invitation.id,
        clanId,
        clanName: actor.clan.name,
        invitorName: invitor?.name ?? 'An officer',
      },
    })
    log.info('clan invite issued', { clanId, targetPlayerId, invitationId: invitation.id })
    const clanRow = await tx.clan.findUnique({
      where: { id: clanId },
      select: { name: true, tag: true },
    })
    return {
      id: invitation.id,
      clanId,
      clanName: clanRow?.name ?? actor.clan.name,
      clanTag: clanRow?.tag ?? actor.clan.tag,
      invitorName: invitor?.name ?? 'An officer',
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
    }
  })
}

export async function removeMember(
  actorPlayerId: string,
  clanId: string,
  targetPlayerId: string,
): Promise<{ removedPlayerId: string }> {
  return runClanTransaction(async (tx) => {
    const actor = await tx.clanMember.findUnique({
      where: { playerId: actorPlayerId },
      select: { role: true, clanId: true },
    })
    if (!actor || actor.clanId !== clanId)
      throw new AppError('NOT_IN_CLAN', 'You are not in this clan')
    if (roleRank(actor.role) < roleRank('OFFICER')) {
      throw new AppError('CLAN_ROLE_REQUIRED', 'Only the leader or an officer can remove members')
    }
    if (actorPlayerId === targetPlayerId) {
      throw new AppError('VALIDATION_ERROR', 'Use leave to exit your own clan')
    }
    const target = await tx.clanMember.findUnique({
      where: { playerId: targetPlayerId },
      include: { clan: { select: { id: true, leaderPlayerId: true } } },
    })
    if (!target || target.clanId !== clanId) {
      throw new AppError('NOT_IN_CLAN', 'That player is not in this clan')
    }
    if (target.clan.leaderPlayerId === targetPlayerId) {
      throw new AppError(
        'CLAN_ROLE_REQUIRED',
        'The leader cannot be removed — transfer leadership first',
      )
    }
    // Nobody manages an equal or higher rank.
    if (roleRank(target.role) >= roleRank(actor.role)) {
      throw new AppError('CLAN_ROLE_REQUIRED', 'You cannot remove a member of equal or higher rank')
    }

    await tx.clanMember.delete({ where: { id: target.id } })
    await tx.clan.update({ where: { id: clanId }, data: { memberCount: { decrement: 1 } } })
    await tx.player.update({
      where: { id: targetPlayerId },
      data: { clanId: null, clanRole: null },
    })
    log.info('clan member removed', { clanId, targetPlayerId, actorPlayerId })
    return { removedPlayerId: targetPlayerId }
  })
}

export async function setMemberRole(
  actorPlayerId: string,
  clanId: string,
  targetPlayerId: string,
  role: unknown,
): Promise<{ playerId: string; role: 'OFFICER' | 'MEMBER' }> {
  if (role !== 'OFFICER' && role !== 'MEMBER') {
    throw new AppError('VALIDATION_ERROR', 'role must be OFFICER or MEMBER')
  }
  const now = new Date()
  return runClanTransaction(async (tx) => {
    const actor = await tx.clanMember.findUnique({
      where: { playerId: actorPlayerId },
      include: { clan: { select: { id: true, leaderPlayerId: true } } },
    })
    if (!actor || actor.clanId !== clanId)
      throw new AppError('NOT_IN_CLAN', 'You are not in this clan')
    if (actor.clan.leaderPlayerId !== actorPlayerId) {
      throw new AppError('CLAN_ROLE_REQUIRED', 'Only the leader can change roles')
    }
    if (actorPlayerId === targetPlayerId) {
      throw new AppError('VALIDATION_ERROR', 'You cannot change your own role')
    }
    const target = await tx.clanMember.findUnique({
      where: { playerId: targetPlayerId },
      select: { id: true, role: true, clanId: true },
    })
    if (!target || target.clanId !== clanId) {
      throw new AppError('NOT_IN_CLAN', 'That player is not in this clan')
    }
    if (target.role === 'LEADER') {
      throw new AppError('VALIDATION_ERROR', 'Use leadership transfer to change the leader')
    }
    if (target.role === role) {
      throw new AppError('VALIDATION_ERROR', `That member is already ${role}`)
    }

    await tx.clanMember.update({ where: { id: target.id }, data: { role, updatedAt: now } })
    await tx.player.update({
      where: { id: targetPlayerId },
      data: { clanRole: role },
    })
    log.info('clan role changed', { clanId, targetPlayerId, role, actorPlayerId })
    return { playerId: targetPlayerId, role }
  })
}

export async function transferLeadership(
  actorPlayerId: string,
  clanId: string,
  targetPlayerId: string,
): Promise<ClanDetailView> {
  const now = new Date()
  return runClanTransaction(async (tx) => {
    const clan = await tx.clan.findUnique({ where: { id: clanId } })
    if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')
    if (clan.leaderPlayerId !== actorPlayerId) {
      throw new AppError('CLAN_ROLE_REQUIRED', 'Only the leader can transfer leadership')
    }
    if (actorPlayerId === targetPlayerId) {
      throw new AppError('VALIDATION_ERROR', 'You already lead this clan')
    }
    const target = await tx.clanMember.findUnique({
      where: { playerId: targetPlayerId },
      select: { id: true, clanId: true, role: true },
    })
    if (!target || target.clanId !== clanId) {
      throw new AppError('NOT_IN_CLAN', 'The new leader must be a member of this clan')
    }

    // Swap: new leader becomes LEADER, old leader becomes OFFICER. Both the
    // Clan row (authority) and the role mirrors update in this one tx.
    await tx.clanMember.update({
      where: { id: target.id },
      data: { role: 'LEADER', updatedAt: now },
    })
    await tx.clanMember.update({
      where: { playerId: actorPlayerId },
      data: { role: 'OFFICER', updatedAt: now },
    })
    await tx.clan.update({
      where: { id: clanId },
      data: { leaderPlayerId: targetPlayerId, updatedAt: now },
    })
    await tx.player.update({ where: { id: targetPlayerId }, data: { clanRole: 'LEADER' } })
    await tx.player.update({ where: { id: actorPlayerId }, data: { clanRole: 'OFFICER' } })

    // Fan-out one CLAN_LEADERSHIP_CHANGED to every member (deduped).
    const memberIds = (
      await tx.clanMember.findMany({ where: { clanId }, select: { playerId: true } })
    ).map((row) => row.playerId)
    const oldLeader = await tx.player.findUnique({
      where: { id: actorPlayerId },
      select: { name: true },
    })
    const newLeader = await tx.player.findUnique({
      where: { id: targetPlayerId },
      select: { name: true },
    })
    await enqueueNotificationFanOutInTx(tx, memberIds, {
      type: 'CLAN_LEADERSHIP_CHANGED',
      dedupeKeyFor: () => notificationDedupeKeys.clanLeadership(clanId, targetPlayerId),
      payloadFor: () => ({
        clanId,
        clanName: clan.name,
        oldLeaderName: oldLeader?.name ?? 'The old leader',
        newLeaderName: newLeader?.name ?? 'The new leader',
      }),
    })

    log.info('clan leadership transferred', { clanId, from: actorPlayerId, to: targetPlayerId })
    return getClanDetailInTx(tx, clanId, actorPlayerId)
  })
}

// ── Read paths ───────────────────────────────────────────────────────────────

async function getClanDetailInTx(
  tx: Tx,
  clanId: string,
  viewerPlayerId: string | null,
): Promise<ClanDetailView> {
  const clan = await tx.clan.findUnique({
    where: { id: clanId },
    include: {
      leader: { select: { name: true } },
      members: {
        include: { player: { select: { name: true, power: true, level: true } } },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      },
    },
  })
  if (!clan) throw new AppError('CLAN_NOT_FOUND', 'Clan not found')
  const pending = await tx.clanInvitation.count({ where: { clanId, status: 'PENDING' } })
  const members: ClanMemberView[] = clan.members.map((member) => ({
    playerId: member.playerId,
    name: member.player.name,
    role: member.role as 'LEADER' | 'OFFICER' | 'MEMBER',
    power: member.player.power.toString(),
    level: member.player.level,
    joinedAt: member.joinedAt.toISOString(),
  }))
  members.sort(
    (a, b) => roleRank(b.role) - roleRank(a.role) || a.joinedAt.localeCompare(b.joinedAt),
  )
  const viewer = viewerPlayerId ? members.find((m) => m.playerId === viewerPlayerId) : undefined
  return {
    ...summaryView(clan),
    members,
    viewerRole: viewer?.role ?? null,
    pendingInvitationCount: pending,
  }
}

export async function getClanDetail(
  clanId: string,
  viewerPlayerId: string | null,
): Promise<ClanDetailView> {
  return getClanDetailInTx(dbWrite, clanId, viewerPlayerId)
}

export async function listClans(options: {
  page?: number
  pageSize?: number
}): Promise<ClanListPage> {
  const page = Math.max(1, Math.floor(options.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 20)))
  const [total, clans] = await Promise.all([
    dbWrite.clan.count(),
    dbWrite.clan.findMany({
      include: { leader: { select: { name: true } } },
      orderBy: [{ memberCount: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    clans: clans.map((clan) => summaryView(clan)),
    page,
    pageSize,
    total,
  }
}

export async function listMyInvitations(
  playerId: string,
): Promise<{ invitations: ClanInvitationView[] }> {
  const now = new Date()
  const rows = await dbWrite.clanInvitation.findMany({
    where: { playerId, status: 'PENDING', expiresAt: { gt: now } },
    include: {
      clan: { select: { name: true, tag: true } },
      invitedBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return {
    invitations: rows.map((row) => ({
      id: row.id,
      clanId: row.clanId,
      clanName: row.clan.name,
      clanTag: row.clan.tag,
      invitorName: row.invitedBy.name,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
  }
}

/** The caller's own membership view (clan panel head). */
export async function getMyClan(playerId: string): Promise<ClanDetailView | null> {
  const member = await dbWrite.clanMember.findUnique({
    where: { playerId },
    select: { clanId: true },
  })
  if (!member) return null
  return getClanDetailInTx(dbWrite, member.clanId, playerId)
}

/** Lazy invitation expiry pass (idempotent — used by ops ticks). */
export async function expireStaleInvitations(now: Date): Promise<number> {
  const result = await dbWrite.clanInvitation.updateMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  })
  return result.count
}
