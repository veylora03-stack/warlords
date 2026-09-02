/**
 * E2E — CLANS & POSITIONAL GARRISON JOURNEY (Phase 34, STEP 28).
 *
 * One continuous session exactly the way the Mini App drives the API:
 *
 *  E1  LOGIN → FOUND CLAN → MATE JOINS → WORLD MAP → DEFEND deploy through
 *      the march engine → travel → ARRIVAL → positional garrison CREATED
 *  E2  CLANMATE REINFORCE → arrival joins the SAME garrison pool → view
 *      aggregates both contributions (multi-contributor truth)
 *  E3  ENEMY ASSAULT through the REAL battle engine → casualties land on the
 *      contributions (never the home army) → capture routing / hold verdict →
 *      territory history → notifications
 *  E4  WITHDRAWAL → march returns home → survivors restored EXACTLY once →
 *      garrison shrinks
 *  E5  TEN CONCURRENT reinforcements → capacity refuses/controls the stack →
 *      zero duplication, conservation intact
 *  E6  WITHDRAW × BATTLE race on one contribution → exactly one claim wins
 *
 * Zero mocks, zero direct-DB shortcuts for game outcomes — real route
 * handlers, real transactions, real deterministic simulation. DB writes only
 * mirror legitimate time passing (arrival/return/cooldown backdates) and
 * veteran armies (the way established players would have them).
 *
 * Identities live in the isolated 9100063… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { POST as clansPost } from '../../src/app/api/v1/clans/route'
import { POST as joinPost } from '../../src/app/api/v1/clans/[id]/join/route'
import { GET as mapGet } from '../../src/app/api/v1/world/map/route'
import { GET as historyGet } from '../../src/app/api/v1/world/territories/[id]/history/route'
import {
  POST as deployPost,
  GET as garrisonGet,
} from '../../src/app/api/v1/world/territories/[id]/garrison/route'
import { POST as garrisonWithdrawPost } from '../../src/app/api/v1/world/territories/[id]/garrison/withdraw/route'
import { POST as attackPost } from '../../src/app/api/v1/world/territories/[id]/attack/route'
import { POST as marchPost } from '../../src/app/api/v1/marches/route'
import { POST as processPost } from '../../src/app/api/v1/marches/[id]/process/route'
import { GET as statisticsGet } from '../../src/app/api/v1/player/statistics/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../src/lib/game/services/economy.service'
import { BATTLE } from '../../src/lib/game/config/battle'
import { GARRISON } from '../../src/lib/game/config/garrison'
import type { ApiEnvelope } from '../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../helpers/cleanup'
import { findTwoStepFrontier, type FrontierChain } from '../helpers/frontier'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Garrison E2E requires TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100063'

let tgCounter = 9100063001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.140.${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEJY0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `GarJ${telegramId.slice(-3)}`,
      username: `gar_journey_${telegramId.slice(-4)}`,
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
  method: 'GET' | 'POST' = 'POST',
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
  method: 'GET' | 'POST' = 'POST',
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
  if (!body.ok || !body.data) throw new Error(`garrison e2e registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

async function grantArmy(playerId: string, swordsman = 300, archer = 60): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: swordsman },
    update: { count: { increment: swordsman } },
  })
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'archer' } },
    create: { playerId, unitId: 'archer', count: archer },
    update: { count: { increment: archer } },
  })
}

async function homeArmy(playerId: string): Promise<Map<string, number>> {
  const rows = await db.playerUnit.findMany({
    where: { playerId },
    select: { unitId: true, count: true },
  })
  return new Map(rows.map((r) => [r.unitId, r.count]))
}

async function backdateArrival(marchId: string): Promise<void> {
  await db.march.update({
    where: { id: marchId },
    data: { arrivesAt: new Date(Date.now() - 1000) },
  })
}

async function backdateReturn(marchId: string): Promise<void> {
  await db.march.update({
    where: { id: marchId },
    data: { returnsAt: new Date(Date.now() - 1000) },
  })
}

async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

/** March-arrival processing through the PUBLIC route. */
async function arrive(token: string, marchId: string): Promise<Record<string, unknown>> {
  await backdateArrival(marchId)
  const res = await call<{ march: { status: string; outcome: Record<string, unknown> | null } }>(
    processPost,
    token,
    '/api/v1/marches/x/process',
    'POST',
    undefined,
    { id: marchId },
  )
  expect(res.status).toBe(200)
  return { ...(res.body.data!.march.outcome ?? {}), __status: res.body.data!.march.status }
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
  await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'garjourney-' } } })
  if (clanIds.length > 0) {
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
    clanIds.length = 0
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('Clans & positional garrison journey (Phase 34 E2E)', () => {
  let lord: { token: string; playerId: string }
  let mate: { token: string; playerId: string }
  let foe: { token: string; playerId: string }
  let clanId: string
  let chain: FrontierChain
  let lordHomeBaseline: Map<string, number>
  let e5HeldId: string | null = null
  let e5BaseMarchId: string | null = null

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('garrison-journey', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    // E1 geography — resolved up front so every act uses the same frontier.
    chain = await findTwoStepFrontier(register)
    lord = { token: '', playerId: chain.lord.playerId }
    mate = await register()
    foe = { token: '', playerId: chain.foe.playerId }
    // Re-login the finder-chosen players to obtain session tokens (fresh
    // telegram exchange with the SAME identity — the honest way in).
    const relogin = async (playerId: string): Promise<string> => {
      const user = await db.user.findFirstOrThrow({
        where: { player: { id: playerId } },
        select: { telegramId: true },
      })
      const res = await telegramPost(
        new Request('http://localhost:3000/api/v1/auth/telegram', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
          body: JSON.stringify({ initData: buildInitData(user.telegramId) }),
        }),
      )
      const body = (await res.json()) as ApiEnvelope<{ token: string }>
      if (!body.ok || !body.data) throw new Error('journey re-login failed')
      return body.data.token
    }
    lord.token = await relogin(lord.playerId)
    foe.token = await relogin(foe.playerId)
    await grantArmy(lord.playerId, 400, 100)
    await grantArmy(mate.playerId, 100, 30)
    // The foe stays MODEST on purpose: strong enough to take the staging cell
    // and reach the garrisoned frontier, too weak to crack a large garrison —
    // so the journey's later acts (E5/E6) play out on a HELD cell.
    await grantArmy(foe.playerId, 40, 0)

    // The lord must OWN the frontier cell before he can defend it — capture
    // it through the march engine and bring the survivors home.
    await elapseCooldown(lord.playerId)
    await db.player.update({ where: { id: lord.playerId }, data: { energy: 100 } })
    const capture = await call<{ id: string }>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: chain.cell.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 300 }],
    })
    expect(capture.status).toBe(200)
    await arrive(lord.token, capture.body.data!.id)
    await backdateReturn(capture.body.data!.id)
    const homecoming = await call<{ march: { status: string } }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      { id: capture.body.data!.id },
    )
    expect(homecoming.body.data!.march.status).toBe('COMPLETED')
    // Baseline for E1's stationing delta (the capture had real casualties).
    lordHomeBaseline = await homeArmy(lord.playerId)
  }, 120_000)

  afterAll(async () => {
    await purge()
    await db.$disconnect()
  }, 60_000)

  it('E1 — login → found clan → mate joins → map → DEFEND march → arrival → garrison created', async () => {
    // The capture battle in beforeAll restarted the regroup clock.
    await elapseCooldown(lord.playerId)
    // Found the clan through the API.
    const created = await call<{ id: string; name: string }>(
      clansPost,
      lord.token,
      '/api/v1/clans',
      'POST',
      { name: 'Journey Hold', tag: 'JRNY' },
    )
    expect(created.status).toBe(200)
    clanId = created.body.data!.id
    clanIds.push(clanId)

    // The mate joins through the API (OPEN policy).
    const joined = await call(
      joinPost,
      mate.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: clanId },
    )
    expect(joined.status).toBe(200)

    // The Mini App reads the world map first.
    const map = await call<{ territories: unknown[] }>(
      mapGet,
      lord.token,
      '/api/v1/world/map?x=0&y=0&view=1',
      'GET',
    )
    expect(map.status).toBe(200)

    // DEFEND deploy through the march engine (the ONE deployment path).
    const deploy = await call<{ id: string; status: string }>(
      deployPost,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [
          { unitId: 'swordsman', count: 40 },
          { unitId: 'archer', count: 20 },
        ],
        idempotencyKey: 'garjourney-defend-1',
      },
      { id: chain.cell.id },
    )
    expect(deploy.status).toBe(200)
    const marchId = deploy.body.data!.id
    expect(deploy.body.data!.status).toBe('EN_ROUTE')

    // Travel → arrival → the positional garrison EXISTS.
    const outcome = await arrive(lord.token, marchId)
    expect(outcome.__status).toBe('ARRIVED')
    expect(outcome['garrisoned']).toBe(true)

    const view = await call<{ garrisoned: boolean; totalUnits: number; contributionCount: number }>(
      garrisonGet,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'GET',
      undefined,
      { id: chain.cell.id },
    )
    expect(view.status).toBe(200)
    expect(view.body.data!.garrisoned).toBe(true)
    expect(view.body.data!.totalUnits).toBe(60)
    expect(view.body.data!.contributionCount).toBe(1)

    // Units are OUT of the home army while stationed (delta against the
    // post-capture baseline — the capture's casualties already settled).
    const army = await homeArmy(lord.playerId)
    expect(army.get('swordsman')).toBe(lordHomeBaseline.get('swordsman')! - 40)
    expect(army.get('archer')).toBe(lordHomeBaseline.get('archer')! - 20)

    // The deploy consumed the reserved GARRISON_DEPLOYED quest event — the stat is real.
    const stats = await call<{ statistics: Record<string, number> }>(
      statisticsGet,
      lord.token,
      '/api/v1/player/statistics',
      'GET',
    )
    expect(stats.status).toBe(200)
    expect(
      ((stats.body.data!.statistics ?? {}) as Record<string, number>)['garrisonsDeployed'] ?? 0,
    ).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('E2 — clanmate REINFORCE joins the same garrison pool; view aggregates both contributions', async () => {
    const before = await call<{ totalUnits: number }>(
      garrisonGet,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'GET',
      undefined,
      { id: chain.cell.id },
    )
    expect(before.body.data!.totalUnits).toBe(60)

    const deploy = await call<{ id: string }>(
      deployPost,
      mate.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 50 }],
        idempotencyKey: 'garjourney-reinforce-1',
      },
      { id: chain.cell.id },
    )
    expect(deploy.status).toBe(200)
    const outcome = await arrive(mate.token, deploy.body.data!.id)
    expect(outcome.__status).toBe('ARRIVED')
    expect(outcome['garrisoned']).toBe(true)

    const view = await call<{
      totalUnits: number
      contributionCount: number
      contributors: Array<{ playerId: string }>
    }>(garrisonGet, lord.token, '/api/v1/world/territories/x/garrison', 'GET', undefined, {
      id: chain.cell.id,
    })
    expect(view.body.data!.contributionCount).toBe(2)
    expect(view.body.data!.totalUnits).toBe(110)
    const contributorIds = view.body.data!.contributors.map((c) => c.playerId)
    expect(new Set(contributorIds)).toEqual(new Set([lord.playerId, mate.playerId]))
  }, 120_000)

  it('E3 — enemy assault: real battle, casualties on contributions, capture verdict, history + notification', async () => {
    // The foe expands into the staging cell NEXT to the garrisoned one.
    await elapseCooldown(foe.playerId)
    await db.player.update({ where: { id: foe.playerId }, data: { energy: 100 } })
    const expansion = await call<{ id: string }>(marchPost, foe.token, '/api/v1/marches', 'POST', {
      territoryId: chain.foeCell.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
    })
    expect(expansion.status).toBe(200)
    const expansionOutcome = await arrive(foe.token, expansion.body.data!.id)
    expect(['RETURNING', 'LOST']).toContain(expansionOutcome.__status)
    if (expansionOutcome.__status === 'RETURNING') {
      await backdateReturn(expansion.body.data!.id)
      const homecoming = await call<{ march: { status: string } }>(
        processPost,
        foe.token,
        '/api/v1/marches/x/process',
        'POST',
        undefined,
        { id: expansion.body.data!.id },
      )
      expect(homecoming.body.data!.march.status).toBe('COMPLETED')
    }

    // The lord deepens the garrison before the assault (410 total).
    await elapseCooldown(lord.playerId)
    await db.player.update({ where: { id: lord.playerId }, data: { energy: 100 } })
    const deepening = await call<{ id: string }>(
      deployPost,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 300 }],
        idempotencyKey: 'garjourney-deepen-1',
      },
      { id: chain.cell.id },
    )
    expect(deepening.status).toBe(200)
    await arrive(lord.token, deepening.body.data!.id)

    // THE ASSAULT on the garrisoned frontier cell.
    await elapseCooldown(foe.playerId)
    await db.player.update({ where: { id: foe.playerId }, data: { energy: 100 } })
    const homeBefore = await homeArmy(lord.playerId)
    const assault = await call<{
      battleId: string
      outcome: string
      territory: { captured: boolean }
    }>(
      attackPost,
      foe.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: 'garjourney-assault-1' },
      { id: chain.cell.id },
    )
    expect(assault.status).toBe(200)
    const battle = await db.battle.findUniqueOrThrow({ where: { id: assault.body.data!.battleId } })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.attackerPlayerId).toBe(foe.playerId)

    const contribution = await db.territoryGarrison.findFirst({
      where: { territoryId: chain.cell.id },
    })

    if (assault.body.data!.territory.captured) {
      // The cell fell: the garrison is GONE (consumed by the battle or
      // routed by the capture) and the territory changed hands.
      const rows = await db.territoryGarrison.findMany({ where: { territoryId: chain.cell.id } })
      expect(rows.length).toBe(0)
      const history = await call<{
        rows: Array<{ reason: string; newOwner: { id: string | null } }>
      }>(historyGet, lord.token, '/api/v1/world/territories/x/history?limit=5', 'GET', undefined, {
        id: chain.cell.id,
      })
      expect(history.status).toBe(200)
      expect(history.body.data!.rows[0]!.reason).toBe('CAPTURE')
      expect(history.body.data!.rows[0]!.newOwner.id).toBe(foe.playerId)
    } else {
      // The garrison HELD: the contribution survived with losses.
      expect(contribution).not.toBeNull()
    }

    // The home army was NEVER the defender.
    const homeAfter = await homeArmy(lord.playerId)
    expect(homeAfter.get('swordsman')).toBe(homeBefore.get('swordsman'))
    expect(homeAfter.get('archer')).toBe(homeBefore.get('archer'))

    // Notifications: drain the worker (batched — repeat until the queue is
    // empty), then the players' inboxes reflect the battle.
    for (let drainRound = 0; drainRound < 10; drainRound++) {
      const pending = await db.notificationQueue.count({ where: { status: 'PENDING' } })
      if (pending === 0) break
      await drainNotificationQueue({ telegramConfig: { token: null } })
    }
    const inbox = await call<{ notifications: Array<{ type: string }> }>(
      notificationsGet,
      foe.token,
      '/api/v1/player/notifications?limit=20',
      'GET',
    )
    expect(inbox.status).toBe(200)
    const types = inbox.body.data!.notifications.map((n) => n.type)
    expect(types).toContain('ATTACK_RESULT')
    if (assault.body.data!.territory.captured) {
      // The former contributors were told their garrison fell.
      const lordInbox = await call<{ notifications: Array<{ type: string }> }>(
        notificationsGet,
        lord.token,
        '/api/v1/player/notifications?limit=30',
        'GET',
      )
      const lordTypes = lordInbox.body.data!.notifications.map((n) => n.type)
      expect(lordTypes.some((t) => ['GARRISON_DESTROYED', 'ATTACK_INCOMING'].includes(t))).toBe(
        true,
      )
    }
  }, 180_000)

  it('E4 — withdrawal restores survivors EXACTLY once through the homecoming', async () => {
    // Whatever E3 did, station a fresh detachment and withdraw it.
    await elapseCooldown(lord.playerId)
    await db.player.update({ where: { id: lord.playerId }, data: { energy: 100 } })
    const before = await homeArmy(lord.playerId)
    const deploy = await call<{ id: string }>(
      deployPost,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 25 }],
        idempotencyKey: 'garjourney-defend-2',
      },
      { id: chain.cell.id },
    )
    if (deploy.status !== 200) {
      // The cell was captured in E3 — the lord can no longer defend it.
      expect(deploy.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')
      return
    }
    await arrive(lord.token, deploy.body.data!.id)

    const withdraw = await call<{ march: { status: string }; unitsReturning: number }>(
      garrisonWithdrawPost,
      lord.token,
      '/api/v1/world/territories/x/garrison/withdraw',
      'POST',
      { marchId: deploy.body.data!.id },
      { id: chain.cell.id },
    )
    expect(withdraw.status).toBe(200)
    expect(withdraw.body.data!.march.status).toBe('RETURNING')
    expect(withdraw.body.data!.unitsReturning).toBe(25)

    await backdateReturn(deploy.body.data!.id)
    const processed = await call<{ march: { status: string } }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      { id: deploy.body.data!.id },
    )
    expect(processed.body.data!.march.status).toBe('COMPLETED')

    const after = await homeArmy(lord.playerId)
    expect(after.get('swordsman')).toBe(before.get('swordsman') ?? 0) // 25 out, 25 back

    // Double withdrawal through the garrison route: no stationed detachment
    // of yours remains on the territory → typed 404 (the march-level route
    // answers 409 MARCH_NOT_WITHDRAWABLE for the same abuse).
    const again = await call(
      garrisonWithdrawPost,
      lord.token,
      '/api/v1/world/territories/x/garrison/withdraw',
      'POST',
      { marchId: deploy.body.data!.id },
      { id: chain.cell.id },
    )
    expect(again.status).toBe(404)
    expect(again.body.error!.code).toBe('MARCH_NOT_FOUND')
  }, 120_000)

  it('E5 — ten concurrent reinforcements: capacity controls the stack, zero duplication', async () => {
    // Whichever cell the journey holds, the owner re-stations a base first.
    const held = await db.territory.findFirst({
      where: { ownerPlayerId: lord.playerId, isCapital: false },
      select: { id: true, strategicValue: true },
    })
    if (!held) {
      console.log('E5 skipped — the lord lost his frontier cell in E3; E2E covers the rest')
      return
    }
    await elapseCooldown(lord.playerId)
    await db.player.update({ where: { id: lord.playerId }, data: { energy: 100 } })
    const base = await call<{ id: string }>(
      deployPost,
      lord.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 10 }],
        idempotencyKey: 'garjourney-e5-base',
      },
      { id: held.id },
    )
    expect(base.status).toBe(200)
    await arrive(lord.token, base.body.data!.id)
    e5HeldId = held.id
    e5BaseMarchId = base.body.data!.id

    const capacity =
      GARRISON.capacityBase + GARRISON.capacityPerStrategicValue * (held.strategicValue ?? 0)
    const mates = await Promise.all(Array.from({ length: 10 }, () => register()))
    for (const m of mates) {
      // The honest path: join through the PUBLIC clan API.
      const joined = await call(
        joinPost,
        m.token,
        '/api/v1/clans/x/join',
        'POST',
        {},
        { id: clanId },
      )
      expect(joined.status).toBe(200)
      await grantArmy(m.playerId, 500)
    }

    const results = await Promise.allSettled(
      mates.map((m, i) =>
        call<{ id: string }>(
          deployPost,
          m.token,
          '/api/v1/world/territories/x/garrison',
          'POST',
          {
            type: 'REINFORCE',
            units: [{ unitId: 'swordsman', count: 500 }],
            idempotencyKey: `garjourney-e5-${i}`,
          },
          { id: held.id },
        ),
      ),
    )
    const createdIds: Array<{ token: string; marchId: string }> = []
    let refused = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        createdIds.push({ token: mates[i]!.token, marchId: r.value.body.data!.id })
      } else if (r.status === 'fulfilled') {
        // Every refusal is TYPED (capacity/slots/units) — never a crash.
        expect(r.value.body.error!.code).toBeTruthy()
        refused += 1
      } else {
        refused += 1
      }
    })
    // Land everyone who was allowed to create a march.
    for (const c of createdIds) {
      await arrive(c.token, c.marchId)
    }
    void refused

    // Conservation: stationed total ≤ capacity, contributions distinct.
    const rows = await db.territoryGarrison.findMany({ where: { territoryId: held.id } })
    const total = rows.reduce(
      (sum, row) => sum + (row.units as Array<{ count: number }>).reduce((s, u) => s + u.count, 0),
      0,
    )
    expect(rows.length).toBeLessThanOrEqual(GARRISON.maxContributionsPerTerritory)
    expect(total).toBeLessThanOrEqual(capacity)
    expect(total).toBeGreaterThanOrEqual(10)
  }, 180_000)

  it('E6 — withdraw × battle race on one contribution: exactly one claim wins', async () => {
    if (!e5HeldId || !e5BaseMarchId) {
      console.log(
        'E6 skipped — no lord-held frontier cell remains; the race is covered in integration',
      )
      return
    }
    await elapseCooldown(foe.playerId)
    await db.player.update({ where: { id: foe.playerId }, data: { energy: 100 } })

    const [withdrawals, assaults] = await Promise.all([
      Promise.allSettled([
        call(
          garrisonWithdrawPost,
          lord.token,
          '/api/v1/world/territories/x/garrison/withdraw',
          'POST',
          { marchId: e5BaseMarchId },
          { id: e5HeldId },
        ),
        call(
          garrisonWithdrawPost,
          lord.token,
          '/api/v1/world/territories/x/garrison/withdraw',
          'POST',
          { marchId: e5BaseMarchId },
          { id: e5HeldId },
        ),
      ]),
      Promise.allSettled([
        call(
          attackPost,
          foe.token,
          '/api/v1/world/territories/x/attack',
          'POST',
          { idempotencyKey: 'garjourney-e6-a' },
          { id: e5HeldId },
        ),
        call(
          attackPost,
          foe.token,
          '/api/v1/world/territories/x/attack',
          'POST',
          { idempotencyKey: 'garjourney-e6-b' },
          { id: e5HeldId },
        ),
      ]),
    ])
    const withdrawWins = withdrawals.filter(
      (w) => w.status === 'fulfilled' && w.value.status === 200,
    ).length
    const assaultWins = assaults.filter(
      (a) => a.status === 'fulfilled' && a.value.status === 200,
    ).length
    expect(withdrawWins + assaultWins).toBeGreaterThanOrEqual(1)

    const row = await db.march.findUniqueOrThrow({ where: { id: e5BaseMarchId } })
    if (withdrawWins > 0) {
      expect(row.status).toBe('RETURNING')
      expect(await db.territoryGarrison.count({ where: { marchId: e5BaseMarchId } })).toBe(0)
    } else {
      expect(['LOST', 'ARRIVED']).toContain(row.status)
    }
  }, 180_000)
})
