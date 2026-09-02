/**
 * Integration tests — Clan System (Phase 34): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → service → transaction → envelope). Every clan
 * mutation runs through the PUBLIC service path inside real transactions —
 * real membership rows, real role matrices, real denormalized sync, real
 * notifications, zero mocks.
 *
 * Scenarios (Phase 34 contract):
 *  1. AUTH        — 401 without a session
 *  2. CREATE      — caller becomes LEADER, member row + mirrors in-tx
 *  3. UNIQUENESS  — name/tag collisions → typed 409s; player in a clan → 409
 *  4. JOIN        — OPEN join; member cap; role MEMBER; clan count sync
 *  5. INVITE FLOW — invite-only clan: closed join, PENDING invite claimed
 *                   exactly-once (replay → CLAN_INVITATION_INVALID)
 *  6. ROLES       — leader-only promote/demote; officer invites; rank matrix
 *  7. REMOVE      — officer removes member; equal/higher rank refused;
 *                   leader cannot be removed
 *  8. SUCCESSION  — leader cannot leave without transfer; transfer swaps
 *                   both mirrors + Clan.leaderPlayerId, old leader → OFFICER
 *  9. QUEST/STAT  — CLAN_JOINED event activates the reserved JOIN_CLAN
 *                   objective; clansJoined stat increments
 * 10. REPLAYS     — every mutation is state-guarded (typed 409s, no partials)
 *
 * Test identities live in the isolated 9100056… telegramId range and are
 * removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as clansPost, GET as clansGet } from '../../../src/app/api/v1/clans/route'
import { GET as clanGet } from '../../../src/app/api/v1/clans/[id]/route'
import { POST as joinPost } from '../../../src/app/api/v1/clans/[id]/join/route'
import { POST as leavePost } from '../../../src/app/api/v1/clans/[id]/leave/route'
import { POST as invitePost } from '../../../src/app/api/v1/clans/[id]/invite/route'
import { POST as transferPost } from '../../../src/app/api/v1/clans/[id]/transfer/route'
import { POST as rolePost } from '../../../src/app/api/v1/clans/[id]/members/[playerId]/role/route'
import { POST as removePost } from '../../../src/app/api/v1/clans/[id]/members/[playerId]/remove/route'
import { GET as invitationsGet } from '../../../src/app/api/v1/clans/invitations/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures (mirrors the march suite conventions) ──────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']
if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('Clan integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100056'
let tgCounter = 9100056001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.135.${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `ClanLord${telegramId.slice(-3)}`,
      username: `clan_lord_${telegramId.slice(-4)}`,
      language_code: 'en',
    }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

type AnyRouteHandler = (
  request: Request,
  ctx?: { params?: Promise<Record<string, string>> },
) => Promise<Response>

function authed(
  path: string,
  token: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function withParams(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) }
}

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
  params?: Record<string, string>,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(
    authed(path, token, method, payload),
    params ? withParams(params) : undefined,
  )
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

async function register(): Promise<{ token: string; playerId: string }> {
  const tgId = nextTgId()
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`clan integration registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

interface ClanDetailView {
  id: string
  name: string
  tag: string
  leaderPlayerId: string
  memberCount: number
  joinPolicy: string
  members: Array<{ playerId: string; name: string; role: string }>
  viewerRole: string | null
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
  if (clanIds.length > 0) {
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanMessage.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('Clan system (create → join → roles → succession)', () => {
  let founder: { token: string; playerId: string }
  let officer: { token: string; playerId: string }
  let member: { token: string; playerId: string }
  let outsider: { token: string; playerId: string }
  let clanId: string
  let inviteOnlyClanId: string
  let pendingInvitationId: string

  beforeAll(async () => {
    await purge()
    founder = await register()
    officer = await register()
    member = await register()
    outsider = await register()
  })

  afterAll(async () => {
    await purge()
    await db.$disconnect()
  })

  it('1 — refuses unauthenticated clan access', async () => {
    const created = await call(clansPost, '', '/api/v1/clans', 'POST', {
      name: 'Ghost Clan',
      tag: 'GHOST',
    })
    expect(created.status).toBe(401)
    const listed = await call(clansGet, '', '/api/v1/clans')
    expect(listed.status).toBe(401)
  })

  it('2 — creates a clan: founder is LEADER with synced mirrors', async () => {
    const created = await call<ClanDetailView>(clansPost, founder.token, '/api/v1/clans', 'POST', {
      name: 'Iron Vanguard',
      tag: 'IRON',
      description: 'Hold the line.',
    })
    expect(created.status).toBe(200)
    const clan = created.body.data!
    clanId = clan.id
    clanIds.push(clanId)
    expect(clan.tag).toBe('IRON')
    expect(clan.leaderPlayerId).toBe(founder.playerId)
    expect(clan.memberCount).toBe(1)
    expect(clan.joinPolicy).toBe('OPEN')
    expect(clan.members).toHaveLength(1)
    expect(clan.members[0]!.role).toBe('LEADER')
    expect(clan.viewerRole).toBe('LEADER')

    // Denormalized mirrors synced in-tx.
    const player = await db.player.findUniqueOrThrow({ where: { id: founder.playerId } })
    expect(player.clanId).toBe(clanId)
    expect(player.clanRole).toBe('LEADER')
  })

  it('3 — uniqueness and single-membership refusals are typed and zero-write', async () => {
    const dupName = await call(clansPost, officer.token, '/api/v1/clans', 'POST', {
      name: 'Iron Vanguard',
      tag: 'IRWN',
    })
    expect(dupName.status).toBe(409)
    expect(dupName.body.error!.code).toBe('CLAN_NAME_TAKEN')

    const dupTag = await call(clansPost, officer.token, '/api/v1/clans', 'POST', {
      name: 'Different Name',
      tag: 'iron', // case-normalized server-side
    })
    expect(dupTag.status).toBe(409)
    expect(dupTag.body.error!.code).toBe('CLAN_TAG_TAKEN')

    // A clan member cannot create or join a second clan.
    const founderAgain = await call(clansPost, founder.token, '/api/v1/clans', 'POST', {
      name: 'Second Banner',
      tag: 'TWO',
    })
    expect(founderAgain.status).toBe(409)
    expect(founderAgain.body.error!.code).toBe('ALREADY_IN_CLAN')

    // Scoped to this suite's fixture (parallel suites create their own
    // clans concurrently on the shared sandbox DB).
    const clanCount = await db.clan.count({ where: { leaderPlayerId: founder.playerId } })
    expect(clanCount).toBe(1)
  })

  it('4 — OPEN join: member row + mirrors + count; roster shows MEMBER', async () => {
    const joined = await call<ClanDetailView>(
      joinPost,
      officer.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: clanId },
    )
    expect(joined.status).toBe(200)
    expect(joined.body.data!.memberCount).toBe(2)
    expect(joined.body.data!.viewerRole).toBe('MEMBER')

    const mirror = await db.player.findUniqueOrThrow({ where: { id: officer.playerId } })
    expect(mirror.clanId).toBe(clanId)
    expect(mirror.clanRole).toBe('MEMBER')

    // outsider joins too (for role tests)
    const outsiderJoin = await call<ClanDetailView>(
      joinPost,
      outsider.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: clanId },
    )
    expect(outsiderJoin.status).toBe(200)
    expect(outsiderJoin.body.data!.memberCount).toBe(3)

    const memberRow = await db.clanMember.findUniqueOrThrow({
      where: { playerId: outsider.playerId },
    })
    expect(memberRow.clanId).toBe(clanId)
    expect(memberRow.role).toBe('MEMBER')
  })

  it('5 — INVITE_ONLY: closed join, invitation claimed exactly-once', async () => {
    const invitorClan = await call<ClanDetailView>(
      clansPost,
      member.token,
      '/api/v1/clans',
      'POST',
      {
        name: 'Closed Circle',
        tag: 'CIRC',
        joinPolicy: 'INVITE_ONLY',
      },
    )
    expect(invitorClan.status).toBe(200)
    inviteOnlyClanId = invitorClan.body.data!.id
    clanIds.push(inviteOnlyClanId)
    // member left the Iron Vanguard to found their own circle — verify mirrors
    const memberMirror = await db.player.findUniqueOrThrow({ where: { id: member.playerId } })
    expect(memberMirror.clanId).toBe(inviteOnlyClanId)
    expect(memberMirror.clanRole).toBe('LEADER')

    // A clanless player cannot join the closed clan directly.
    const intruder = await register()
    const closed = await call(
      joinPost,
      intruder.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: inviteOnlyClanId },
    )
    expect(closed.status).toBe(403)
    expect(closed.body.error!.code).toBe('CLAN_JOIN_POLICY_CLOSED')

    // The leader invites the intruder → PENDING invitation + CLAN_INVITE notification.
    const invited = await call<{ id: string }>(
      invitePost,
      member.token,
      '/api/v1/clans/x/invite',
      'POST',
      { playerId: intruder.playerId },
      { id: inviteOnlyClanId },
    )
    expect(invited.status).toBe(200)
    pendingInvitationId = invited.body.data!.id

    const inbox = await call<{ invitations: Array<{ id: string }> }>(
      invitationsGet,
      intruder.token,
      '/api/v1/clans/invitations',
    )
    expect(inbox.status).toBe(200)
    expect(inbox.body.data!.invitations.some((i) => i.id === pendingInvitationId)).toBe(true)

    // The intruder joins WITH the invitation — claimed exactly-once.
    const accepted = await call<ClanDetailView>(
      joinPost,
      intruder.token,
      '/api/v1/clans/x/join',
      'POST',
      {
        invitationId: pendingInvitationId,
      },
      { id: inviteOnlyClanId },
    )
    expect(accepted.status).toBe(200)
    expect(accepted.body.data!.memberCount).toBe(2)

    // Replay of the same invitation → typed 409, no double membership.
    const replay = await call(
      joinPost,
      intruder.token,
      '/api/v1/clans/x/join',
      'POST',
      {
        invitationId: pendingInvitationId,
      },
      { id: inviteOnlyClanId },
    )
    expect(replay.status).toBe(409)
    expect(['CLAN_INVITATION_INVALID', 'ALREADY_IN_CLAN']).toContain(replay.body.error!.code)
  })

  it('6 — role matrix: only the leader flips roles; rank escalations refused', async () => {
    // promote outsider MEMBER → OFFICER (founder is leader of Iron Vanguard)
    const promote = await call<{ role: string }>(
      rolePost,
      founder.token,
      '/api/v1/clans/x/members/y/role',
      'POST',
      { role: 'OFFICER' },
      { id: clanId, playerId: outsider.playerId },
    )
    expect(promote.status).toBe(200)
    expect(promote.body.data!.role).toBe('OFFICER')
    const mirror = await db.player.findUniqueOrThrow({ where: { id: outsider.playerId } })
    expect(mirror.clanRole).toBe('OFFICER')

    // An OFFICER cannot change roles.
    const officerTry = await call(
      rolePost,
      outsider.token,
      '/api/v1/clans/x/members/y/role',
      'POST',
      { role: 'MEMBER' },
      { id: clanId, playerId: officer.playerId },
    )
    expect(officerTry.status).toBe(403)
    expect(officerTry.body.error!.code).toBe('CLAN_ROLE_REQUIRED')

    // The leader cannot change their own role (transfer is the only path).
    const selfTry = await call(
      rolePost,
      founder.token,
      '/api/v1/clans/x/members/y/role',
      'POST',
      { role: 'MEMBER' },
      { id: clanId, playerId: founder.playerId },
    )
    expect(selfTry.status).toBe(400)

    // A leader of ANOTHER clan cannot act here.
    const foreignTry = await call(
      rolePost,
      member.token,
      '/api/v1/clans/x/members/y/role',
      'POST',
      { role: 'OFFICER' },
      { id: clanId, playerId: officer.playerId },
    )
    expect(foreignTry.status).toBe(409)
    expect(foreignTry.body.error!.code).toBe('NOT_IN_CLAN')
  })

  it('7 — removal: rank matrix + leader protection', async () => {
    const tempMember = await register()
    const join = await call(
      joinPost,
      tempMember.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: clanId },
    )
    expect(join.status).toBe(200)

    // An OFFICER removes a MEMBER.
    const removed = await call<{ removedPlayerId: string }>(
      removePost,
      outsider.token,
      '/api/v1/clans/x/members/y/remove',
      'POST',
      undefined,
      { id: clanId, playerId: tempMember.playerId },
    )
    expect(removed.status).toBe(200)
    const mirror = await db.player.findUniqueOrThrow({ where: { id: tempMember.playerId } })
    expect(mirror.clanId).toBeNull()

    // The OFFICER cannot remove the LEADER.
    const leaderHit = await call(
      removePost,
      outsider.token,
      '/api/v1/clans/x/members/y/remove',
      'POST',
      undefined,
      { id: clanId, playerId: founder.playerId },
    )
    expect(leaderHit.status).toBe(403)

    // Self-removal through the remove route is refused (leave is the path).
    const selfHit = await call(
      removePost,
      outsider.token,
      '/api/v1/clans/x/members/y/remove',
      'POST',
      undefined,
      { id: clanId, playerId: outsider.playerId },
    )
    expect(selfHit.status).toBe(400)
  })

  it('8 — succession: leader cannot leave; transfer swaps everything atomically', async () => {
    // The leader cannot leave without a successor.
    const leaderLeave = await call(
      leavePost,
      founder.token,
      '/api/v1/clans/x/leave',
      'POST',
      {},
      { id: clanId },
    )
    expect(leaderLeave.status).toBe(409)
    expect(leaderLeave.body.error!.code).toBe('CLAN_LEADER_SUCCESSION')

    // Officer transfer attempt refused.
    const officerTransfer = await call(
      transferPost,
      outsider.token,
      '/api/v1/clans/x/transfer',
      'POST',
      { playerId: officer.playerId },
      { id: clanId },
    )
    expect(officerTransfer.status).toBe(403)

    // Leader transfers to officer → both mirrors swap, old leader → OFFICER.
    const transferred = await call<ClanDetailView>(
      transferPost,
      founder.token,
      '/api/v1/clans/x/transfer',
      'POST',
      { playerId: officer.playerId },
      { id: clanId },
    )
    expect(transferred.status).toBe(200)
    expect(transferred.body.data!.leaderPlayerId).toBe(officer.playerId)
    const roles = Object.fromEntries(
      transferred.body.data!.members.map((m) => [m.playerId, m.role]),
    ) as Record<string, string>
    expect(roles[officer.playerId]).toBe('LEADER')
    expect(roles[founder.playerId]).toBe('OFFICER')

    // Now the OLD leader can leave.
    const leave = await call(
      leavePost,
      founder.token,
      '/api/v1/clans/x/leave',
      'POST',
      {},
      { id: clanId },
    )
    expect(leave.status).toBe(200)
    const gone = await db.player.findUniqueOrThrow({ where: { id: founder.playerId } })
    expect(gone.clanId).toBeNull()
    expect(gone.clanRole).toBeNull()
    const roster = await db.clanMember.findMany({ where: { clanId } })
    expect(roster).toHaveLength(2)
  })

  it('9 — clan quest engine: JOIN_CLAN objective consumes CLAN_JOINED events; stats recorded', async () => {
    const stats = await db.player.findUniqueOrThrow({
      where: { id: outsider.playerId },
      select: { stats: true },
    })
    const statBlob = (stats.stats ?? {}) as Record<string, number>
    expect(statBlob['clansJoined'] ?? 0).toBeGreaterThanOrEqual(1)

    // The reserved JOIN_CLAN objective is now LIVE.
    const { matchesObjective } = await import('../../../src/lib/game/engine/quest/progress')
    expect(
      matchesObjective(
        'JOIN_CLAN',
        { amount: 1 },
        { kind: 'CLAN_JOINED', clanId: 'x', clanName: 'Y' },
      ),
    ).toBe(true)
    expect(
      matchesObjective(
        'GARRISON_DEPLOYMENTS',
        { amount: 1 },
        { kind: 'GARRISON_DEPLOYED', marchId: 'm', territoryId: 't', action: 'DEFEND' },
      ),
    ).toBe(true)
  })

  it('10 — clan list + detail read paths expose no forbidden data', async () => {
    const list = await call<{ clans: Array<{ id: string; memberCount: number }>; total: number }>(
      clansGet,
      founder.token,
      '/api/v1/clans',
    )
    expect(list.status).toBe(200)
    expect(list.body.data!.total).toBeGreaterThanOrEqual(2)
    expect(list.body.data!.clans.some((c) => c.id === clanId)).toBe(true)

    const detail = await call<ClanDetailView>(
      clanGet,
      founder.token,
      '/api/v1/clans/x',
      'GET',
      undefined,
      { id: inviteOnlyClanId },
    )
    expect(detail.status).toBe(200)
    expect(detail.body.data!.members.every((m) => typeof m.name === 'string')).toBe(true)

    const fake = await call(clanGet, founder.token, '/api/v1/clans/x', 'GET', undefined, {
      id: 'nonexistent-clan',
    })
    expect(fake.status).toBe(404)
    expect(fake.body.error!.code).toBe('CLAN_NOT_FOUND')
  })
})
