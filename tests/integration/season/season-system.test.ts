/**
 * Integration tests — Season System (Phases 20/22): rewards · ranking ·
 * settlement · permanent progression · rank-change notifications.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → services → transactions → envelope). All writes
 * run through the PUBLIC service paths inside real transactions — real
 * ledger rows, real claim rows, real SQLite, zero mocks.
 *
 * Required scenarios (Phase 24 QA contract):
 *  1. SEASON VIEW        — rules projection, lazily-resolved ACTIVE season,
 *                          rank null at zero points
 *  2. LIVE RANKING       — deterministic order (points desc, id asc),
 *                          tier names, min-score filter, query validation
 *  3. CLAIM REFUSALS     — pre-settlement claim → typed 404/409, anonymous
 *                          401, malformed body 400, zero writes
 *  4. SETTLEMENT         — admin-only, typed confirmation, at-most-once
 *                          (double execute refused), tiers assigned 1-3/4-10/
 *                          11-50, seasonal wipe, next season created
 *  5. REWARD CLAIM       — exact payout through the ledger, IDEMPOTENT
 *                          replay (alreadyClaimed), CONCURRENT claims converge
 *                          on exactly one payout (double-pay regression)
 *  6. PROGRESSION        — titles/cosmetics/achievements granted, TITLE
 *                          equip ownership check (IDOR regression), clear
 *  7. RANK CHANGE        — RANK_CHANGE notification delivered per ranked
 *                          player via the Phase 22 queue
 *  8. HISTORY            — materialized leaderboard for settled seasons;
 *                          unsettled/unknown refused
 *
 * Test identities live in the isolated 9100024… telegramId range and are
 * removed in afterAll (claims/leaderboards/seasons created by the suite are
 * deleted explicitly; everything else cascades).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as seasonGet } from '../../../src/app/api/v1/season/route'
import { GET as rankingGet } from '../../../src/app/api/v1/season/ranking/route'
import { GET as rewardsGet } from '../../../src/app/api/v1/season/rewards/route'
import { POST as claimPost } from '../../../src/app/api/v1/season/rewards/claim/route'
import { GET as progressionGet } from '../../../src/app/api/v1/season/progression/route'
import { POST as titlePost } from '../../../src/app/api/v1/season/progression/title/route'
import { POST as settlePost } from '../../../src/app/api/v1/admin/season/settle/execute/route'
import { awardSeasonPointsInTx } from '../../../src/lib/game/services/season.service'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { getWalletBalances } from '../../../src/lib/game/services/economy.service'
import { ADMIN_CONFIRMATIONS } from '../../../src/lib/game/config/admin'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Season integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_BASE = '9100024'
let tgCounter = 1
const nextTgId = (): string => `${TG_BASE}${String(tgCounter++).padStart(3, '0')}`
const tgIds: string[] = []

const IP_BASE = '203.0.124.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `SeasonLord${telegramId.slice(-3)}`,
      username: `season_lord_${telegramId.slice(-4)}`,
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

function request(
  path: string,
  token: string | null,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function exchange(telegramId: string): Promise<{ token: string; playerId: string }> {
  const res = await telegramPost(
    request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(telegramId) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error('exchange failed')
  tgIds.push(telegramId)
  return { token: body.data.token, playerId: body.data.player.id }
}

interface Fixture {
  token: string
  playerId: string
}
const players: Fixture[] = []
let unranked: Fixture
let admin: Fixture
let adminUserId = ''

// 12 ranked players, distinct descending scores covering all three tiers:
// ranks 1-3 → Warlord Elite · 4-10 → Frontline Commander · 11-12 → Seasoned Warrior.
const SCORES = [500, 300, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10]

/** The settlement season created by this suite (backdated to have ended). */
let settlementSeasonId = ''
let settlementSeasonNumber = 0

beforeAll(async () => {
  // Deterministic world: zero every player's season points (the settlement
  // wipe would do this anyway — doing it up front makes ranks exact).
  await db.player.updateMany({ data: { seasonPoints: 0 } })

  for (let i = 0; i < SCORES.length; i++) players.push(await exchange(nextTgId()))
  unranked = await exchange(nextTgId()) // 0 points — never ranked
  admin = await exchange(nextTgId())
  const adminUser = await db.user.findUnique({ where: { telegramId: tgIds[tgIds.length - 1] } })
  if (!adminUser) throw new Error('admin user missing')
  adminUserId = adminUser.id
  await db.adminUser.create({ data: { userId: adminUserId, role: 'ADMIN', isActive: true } })

  // Award season points through the REAL production path (the same function
  // building/training claims call inside their transactions).
  for (let i = 0; i < players.length; i++) {
    const awarded = await db.$transaction((tx) =>
      awardSeasonPointsInTx(tx, players[i]!.playerId, SCORES[i]!, 'BUILDING_LEVEL_UP', {
        level: SCORES[i]!,
      }),
    )
    expect(awarded).toBe(SCORES[i])
  }
})

afterAll(async () => {
  const seasonIds = settlementSeasonId ? [settlementSeasonId] : []
  // Seasons created by the settlement (number = settlementSeasonNumber + 1).
  const nextSeasons = settlementSeasonNumber
    ? await db.season.findMany({ where: { number: settlementSeasonNumber + 1 } })
    : []
  seasonIds.push(...nextSeasons.map((s) => s.id))

  if (seasonIds.length > 0) {
    await db.leaderboard.deleteMany({ where: { seasonId: { in: seasonIds } } })
    await db.seasonRewardClaim.deleteMany({ where: { seasonId: { in: seasonIds } } })
    await db.seasonWallet.deleteMany({ where: { seasonId: { in: seasonIds } } })
  }
  await db.notification.deleteMany({ where: { player: { user: { telegramId: { in: tgIds } } } } })
  await db.notificationQueue.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.season.deleteMany({ where: { id: { in: seasonIds } } })
  await db.playerTitle.deleteMany({ where: { player: { user: { telegramId: { in: tgIds } } } } })
  await db.playerCosmetic.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.playerAchievement.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.auditLog.deleteMany({ where: { actorUserId: adminUserId } })
  await db.adminUser.deleteMany({ where: { userId: adminUserId } })
  await db.user.deleteMany({ where: { telegramId: { in: tgIds } } })
})

// ── 1. Season view ───────────────────────────────────────────────────────────

describe('GET /api/v1/season — view & rules projection', () => {
  it('anonymous request → 401 envelope', async () => {
    const res = await seasonGet(request('/api/v1/season', null))
    expect(res.status).toBe(401)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
  })

  it('returns the ACTIVE season, rules and the caller standing', async () => {
    const res = await seasonGet(request('/api/v1/season', players[0]!.token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      season: { id: string; number: number; status: string; timeLeftSec: number | null } | null
      rules: { rewardTiers: Array<{ name: string; fromRank: number; toRank: number }> }
      me: { seasonPoints: number; rank: number | null; shards: string }
      settlementPending: boolean
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.season).not.toBeNull()
    expect(body.data.season!.status).toBe('ACTIVE')
    expect(body.data.season!.timeLeftSec).toBeGreaterThan(0)
    expect(body.data.rules.rewardTiers).toHaveLength(3)
    expect(body.data.me.seasonPoints).toBe(500)
    expect(body.data.me.rank).toBe(1)
    expect(body.data.me.shards).toBe('0')
    expect(body.data.settlementPending).toBe(false)
  })
})

// ── 2. Live ranking ──────────────────────────────────────────────────────────

describe('GET /api/v1/season/ranking — deterministic live ranking', () => {
  it('orders by points desc with tier names and exposes my rank', async () => {
    const res = await rankingGet(request('/api/v1/season/ranking?limit=10', players[0]!.token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      seasonStatus: string
      live: Array<{ rank: number; playerId: string; score: number; tier: string | null }>
      history: null
      me: { rank: number | null; score: number }
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.seasonStatus).toBe('ACTIVE')
    expect(body.data.live).toHaveLength(10)
    expect(body.data.live[0]).toMatchObject({
      rank: 1,
      playerId: players[0]!.playerId,
      score: 500,
      tier: 'Warlord Elite',
    })
    expect(body.data.live[3]!.tier).toBe('Frontline Commander')
    expect(body.data.live[9]!.tier).toBe('Frontline Commander')
    expect(body.data.me).toEqual({ rank: 1, score: 500 })
  })

  it('ranks 11+ land in the Seasoned Warrior tier (tier boundaries exact)', async () => {
    const res = await rankingGet(request('/api/v1/season/ranking?limit=12', players[10]!.token))
    const body = (await res.json()) as ApiEnvelope<{
      live: Array<{ rank: number; playerId: string; tier: string | null }>
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.live[10]).toMatchObject({
      rank: 11,
      playerId: players[10]!.playerId,
      tier: 'Seasoned Warrior',
    })
    expect(body.data.live[11]!.tier).toBe('Seasoned Warrior')
  })

  it('tie-break is deterministic: equal scores order by player id asc', async () => {
    // A twin of P4 (90 points) — craft an exact tie via the real award path.
    const twin = await exchange(nextTgId())
    await db.$transaction((tx) =>
      awardSeasonPointsInTx(tx, twin.playerId, 90, 'UNIT_TRAINED', { tier: 1 }),
    )
    const res = await rankingGet(request('/api/v1/season/ranking?limit=12', twin.token))
    const body = (await res.json()) as ApiEnvelope<{
      live: Array<{ rank: number; playerId: string; score: number }>
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    const pair = body.data.live.filter((row) => row.score === 90)
    expect(pair).toHaveLength(2)
    const [first, second] = pair as [{ playerId: string }, { playerId: string }]
    expect(first.playerId < second.playerId).toBe(true)
    expect(pair[0]!.rank).toBe(pair[1]!.rank - 1)

    // Re-zero the twin so the settlement suite sees exactly the 12 scored
    // players (minScoreToRank=1 puts a 0-point player below the ranking cut).
    await db.player.updateMany({
      where: { id: twin.playerId },
      data: { seasonPoints: 0 },
    })
  })

  it('a zero-point player is unranked (min-score filter)', async () => {
    const res = await rankingGet(request('/api/v1/season/ranking', unranked.token))
    const body = (await res.json()) as ApiEnvelope<{
      live: Array<{ playerId: string }>
      me: { rank: number | null; score: number }
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.live.some((row) => row.playerId === unranked.playerId)).toBe(false)
    expect(body.data.me).toEqual({ rank: null, score: 0 })
  })

  it('query abuse: limit 0 / 1.5 / 1000 / NaN / -5 → 400 VALIDATION_ERROR', async () => {
    for (const limit of ['0', '1.5', '1000', 'NaN', '-5']) {
      const res = await rankingGet(
        request(`/api/v1/season/ranking?limit=${limit}`, players[0]!.token),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as ApiEnvelope<unknown>
      expect(body.ok).toBe(false)
      if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('limit=100 (the route maximum) succeeds and pages the top-100', async () => {
    const res = await rankingGet(request('/api/v1/season/ranking?limit=100', players[0]!.token))
    expect(res.status).toBe(200)
  })
})

// ── 3. Claim refusals (pre-settlement) ───────────────────────────────────────

describe('POST /api/v1/season/rewards/claim — refusals before settlement', () => {
  it('anonymous claim → 401', async () => {
    const res = await claimPost(
      request('/api/v1/season/rewards/claim', null, 'POST', { seasonId: 'whatever' }),
    )
    expect(res.status).toBe(401)
  })

  it('malformed bodies → 400 VALIDATION_ERROR (empty / missing / oversized id)', async () => {
    for (const body of [{ seasonId: '' }, {}, { seasonId: 'x'.repeat(65) }]) {
      const res = await claimPost(
        request('/api/v1/season/rewards/claim', players[0]!.token, 'POST', body),
      )
      expect(res.status).toBe(400)
      const parsed = (await res.json()) as ApiEnvelope<unknown>
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('claiming a season with no claim row → 404 SEASON_REWARD_NOT_FOUND, zero writes', async () => {
    const season = await db.season.findFirst({ orderBy: { number: 'desc' } })
    expect(season).not.toBeNull()
    const before = await db.resourceTransaction.count({ where: { reason: 'SEASON_REWARD' } })
    const res = await claimPost(
      request('/api/v1/season/rewards/claim', players[0]!.token, 'POST', {
        seasonId: season!.id,
      }),
    )
    expect(res.status).toBe(404)
    const parsed = (await res.json()) as ApiEnvelope<unknown>
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('SEASON_REWARD_NOT_FOUND')
    const after = await db.resourceTransaction.count({ where: { reason: 'SEASON_REWARD' } })
    expect(after).toBe(before)
  })

  it('a claim row on an UNSETTLED season → 409 SEASON_NOT_SETTLED', async () => {
    const season = await db.season.findFirst({ orderBy: { number: 'desc' } })
    const planted = await db.seasonRewardClaim.create({
      data: {
        seasonId: season!.id,
        playerId: unranked.playerId,
        rank: 1,
        score: 1,
        tierName: 'Warlord Elite',
        rewards: { GOLD: 1 },
      },
    })
    try {
      const res = await claimPost(
        request('/api/v1/season/rewards/claim', unranked.token, 'POST', { seasonId: season!.id }),
      )
      expect(res.status).toBe(409)
      const parsed = (await res.json()) as ApiEnvelope<unknown>
      if (!parsed.ok) expect(parsed.error.code).toBe('SEASON_NOT_SETTLED')
    } finally {
      await db.seasonRewardClaim.delete({ where: { id: planted.id } })
    }
  })
})

// ── 4. Settlement ────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/season/settle/execute — the transactional reset', () => {
  it('anonymous → 401 · regular player → 403 (RBAC holds end-to-end)', async () => {
    const anon = await settlePost(
      request('/api/v1/admin/season/settle/execute', null, 'POST', {
        seasonNumber: 99,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(anon.status).toBe(401)
    const player = await settlePost(
      request('/api/v1/admin/season/settle/execute', players[0]!.token, 'POST', {
        seasonNumber: 99,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(player.status).toBe(403)
  })

  it('wrong confirmation phrase → 400 VALIDATION_ERROR pointing at `confirm` (zod literal rail)', async () => {
    const res = await settlePost(
      request('/api/v1/admin/season/settle/execute', admin.token, 'POST', {
        seasonNumber: 99,
        confirm: 'reset season',
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) {
      expect(body.error.code).toBe('VALIDATION_ERROR')
      const issues = (body.error.details as { issues?: Array<{ path: string }> } | undefined)
        ?.issues
      expect((issues ?? []).map((i) => i.path)).toContain('confirm')
    }
  })

  it('seasonNumber mismatch with the live season → typed 409', async () => {
    const res = await settlePost(
      request('/api/v1/admin/season/settle/execute', admin.token, 'POST', {
        seasonNumber: 99,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('SETTLEMENT_NOT_PENDING')
  })

  it('settle refuses while the current season has NOT ended (clock authority)', async () => {
    const current = await db.season.findFirst({ orderBy: { number: 'desc' } })
    const res = await settlePost(
      request('/api/v1/admin/season/settle/execute', admin.token, 'POST', {
        seasonNumber: current!.number,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('SETTLEMENT_NOT_PENDING')
  })

  it('settles the ENDED season: tiers 1-3/4-10/11-50, wipe, next season, at-most-once', async () => {
    // Create a season that has already run its course → becomes the LATEST.
    const now = Date.now()
    const ended = await db.season.create({
      data: {
        number: (await db.season.aggregate({ _max: { number: true } }))._max.number! + 1,
        name: 'QA Season — ended',
        startsAt: new Date(now - 31 * 24 * 3600 * 1000),
        endsAt: new Date(now - 3600 * 1000),
        status: 'ACTIVE',
        config: {},
      },
    })
    settlementSeasonId = ended.id
    settlementSeasonNumber = ended.number

    const res = await settlePost(
      request('/api/v1/admin/season/settle/execute', admin.token, 'POST', {
        seasonNumber: ended.number,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      dryRun: boolean
      settledSeason: { id: string; number: number }
      rankedPlayers: number
      tiers: Array<{ tierName: string; players: number; resources: Record<string, number> }>
      wipe: { seasonPointsReset: number; seasonWalletsDeleted: number }
      grants: { rankChangesEnqueued: number }
      nextSeason: { number: number }
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.dryRun).toBe(false)
    expect(body.data.settledSeason.id).toBe(ended.id)
    expect(body.data.rankedPlayers).toBe(SCORES.length)
    const elite = body.data.tiers.find((t) => t.tierName === 'Warlord Elite')
    const frontline = body.data.tiers.find((t) => t.tierName === 'Frontline Commander')
    const seasoned = body.data.tiers.find((t) => t.tierName === 'Seasoned Warrior')
    expect(elite?.players).toBe(3)
    expect(frontline?.players).toBe(7)
    expect(seasoned?.players).toBe(2)
    expect(body.data.wipe.seasonPointsReset).toBeGreaterThanOrEqual(SCORES.length)
    expect(body.data.grants.rankChangesEnqueued).toBe(SCORES.length)
    expect(body.data.nextSeason.number).toBe(ended.number + 1)

    // THE WIPE landed on real rows: every player's season points are zero.
    const p1 = await db.player.findUnique({ where: { id: players[0]!.playerId } })
    expect(p1?.seasonPoints).toBe(0)

    // AT-MOST-ONCE: a second execution is refused with a typed 409.
    const replay = await settlePost(
      request('/api/v1/admin/season/settle/execute', admin.token, 'POST', {
        seasonNumber: ended.number,
        confirm: ADMIN_CONFIRMATIONS.seasonSettle,
      }),
    )
    expect(replay.status).toBe(409)
    const replayBody = (await replay.json()) as ApiEnvelope<unknown>
    if (!replayBody.ok) expect(replayBody.error.code).toBe('SEASON_ALREADY_SETTLED')
  })

  it('RANK_CHANGE notifications ride the Phase 22 queue to every ranked player', async () => {
    // The worker processes a bounded batch per tick — drain until quiescent
    // (the production scheduler re-ticks; a QA drain must do the same).
    for (let tick = 0; tick < 10; tick++) {
      const ticked = await drainNotificationQueue({ batchSize: 50 })
      if (ticked.claimed === 0) break
    }
    for (let i = 0; i < players.length; i++) {
      const rows = await db.notification.findMany({
        where: { playerId: players[i]!.playerId, type: 'RANK_CHANGE' },
      })
      expect(rows).toHaveLength(1)
      const data = rows[0]!.data as { seasonNumber: number; rank: number; tier: string }
      expect(data.rank).toBe(i + 1)
      expect(data.seasonNumber).toBe(settlementSeasonNumber)
    }
  })
})

// ── 5. Reward claims (post-settlement) ───────────────────────────────────────

describe('POST /api/v1/season/rewards/claim — exact, idempotent, concurrency-safe', () => {
  it('rewards view lists the pending payout for a tier finisher', async () => {
    const res = await rewardsGet(request('/api/v1/season/rewards', players[0]!.token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      pending: Array<{
        seasonId: string
        rank: number
        tierName: string
        rewards: Record<string, number>
      }>
      claimed: unknown[]
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.pending).toHaveLength(1)
    expect(body.data.claimed).toHaveLength(0)
    expect(body.data.pending[0]).toMatchObject({
      seasonId: settlementSeasonId,
      rank: 1,
      tierName: 'Warlord Elite',
    })
    expect(body.data.pending[0]!.rewards).toEqual({ GOLD: 5000, CRYSTAL: 50, GEMS: 200 })
  })

  it('pays the EXACT tier payout through the ledger (GOLD/CRYSTAL/GEMS)', async () => {
    const before = await getWalletBalances(db, players[0]!.playerId)
    const gemsBefore = await db.player.findUniqueOrThrow({
      where: { id: players[0]!.playerId },
      select: { gems: true },
    })

    const res = await claimPost(
      request('/api/v1/season/rewards/claim', players[0]!.token, 'POST', {
        seasonId: settlementSeasonId,
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      claim: { rank: number; rewards: Record<string, number>; claimedAt: string | null }
      alreadyClaimed: boolean
      balances: Record<string, string>
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.alreadyClaimed).toBe(false)
    expect(body.data.claim.rank).toBe(1)
    expect(body.data.claim.claimedAt).not.toBeNull()

    expect(BigInt(body.data.balances.GOLD!) - before.GOLD).toBe(5000n)
    expect(BigInt(body.data.balances.CRYSTAL!) - before.CRYSTAL).toBe(50n)
    expect(BigInt(body.data.balances.GEMS!) - gemsBefore.gems).toBe(200n)

    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: players[0]!.playerId, reason: 'SEASON_REWARD' },
    })
    expect(ledger).toHaveLength(3)
    for (const row of ledger) expect(row.refId).toBe(settlementSeasonId)
  })

  it('REPLAY returns the original result with alreadyClaimed=true — no double pay', async () => {
    const balancesBefore = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: players[0]!.playerId },
    })
    const gemsBefore = await db.player.findUniqueOrThrow({
      where: { id: players[0]!.playerId },
      select: { gems: true },
    })

    const res = await claimPost(
      request('/api/v1/season/rewards/claim', players[0]!.token, 'POST', {
        seasonId: settlementSeasonId,
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      alreadyClaimed: boolean
      claim: { claimedAt: string }
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.alreadyClaimed).toBe(true)

    const balancesAfter = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: players[0]!.playerId },
    })
    expect(balancesAfter.gold).toBe(balancesBefore.gold)
    expect(balancesAfter.crystal).toBe(balancesBefore.crystal)
    const gemsAfter = await db.player.findUniqueOrThrow({
      where: { id: players[0]!.playerId },
      select: { gems: true },
    })
    expect(gemsAfter.gems).toBe(gemsBefore.gems)

    const ledger = await db.resourceTransaction.count({
      where: { playerId: players[0]!.playerId, reason: 'SEASON_REWARD' },
    })
    expect(ledger).toBe(3) // still exactly the first payout
  })

  it('CONCURRENT duplicate claims converge on exactly ONE payout (race regression)', async () => {
    const target = players[11]! // rank 12 → Seasoned Warrior payout
    const before = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: target.playerId },
    })
    const gemsBefore = await db.player.findUniqueOrThrow({
      where: { id: target.playerId },
      select: { gems: true },
    })

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimPost(
          request('/api/v1/season/rewards/claim', target.token, 'POST', {
            seasonId: settlementSeasonId,
          }),
        ).then((r) => r.json() as Promise<ApiEnvelope<{ alreadyClaimed: boolean }>>),
      ),
    )
    const firsts = results.filter((b) => b.ok && b.data.alreadyClaimed === false)
    expect(firsts).toHaveLength(1)

    const after = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: target.playerId },
    })
    expect(after.gold - before.gold).toBe(1000n)
    expect(after.crystal - before.crystal).toBe(10n)
    const gemsAfter = await db.player.findUniqueOrThrow({
      where: { id: target.playerId },
      select: { gems: true },
    })
    expect(gemsAfter.gems - gemsBefore.gems).toBe(40n)

    const ledger = await db.resourceTransaction.count({
      where: { playerId: target.playerId, reason: 'SEASON_REWARD' },
    })
    expect(ledger).toBe(3)
  })

  it('an UNRANKED player has no claim row → 404 (cross-player IDOR impossible by key)', async () => {
    const res = await claimPost(
      request('/api/v1/season/rewards/claim', unranked.token, 'POST', {
        seasonId: settlementSeasonId,
      }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('SEASON_REWARD_NOT_FOUND')
  })
})

// ── 6. Permanent progression & title equip ───────────────────────────────────

describe('season progression — titles survive the reset; equip is ownership-checked', () => {
  it('rank-1 finisher owns the champion title, cosmetic and achievement', async () => {
    const res = await progressionGet(request('/api/v1/season/progression', players[0]!.token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      titles: Array<{ id: string; acquiredSeason: number | null; active: boolean }>
      cosmetics: Array<{ id: string }>
      achievements: Array<{ id: string }>
      equippedTitleId: string | null
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.titles.some((t) => t.id === 'title-season-champion')).toBe(true)
    const champion = body.data.titles.find((t) => t.id === 'title-season-champion')
    expect(champion?.acquiredSeason).toBe(settlementSeasonNumber)
    expect(body.data.cosmetics.some((c) => c.id === 'cosmetic-golden-emblem')).toBe(true)
    expect(body.data.achievements.some((a) => a.id === 'ach-season-champion')).toBe(true)
    expect(body.data.equippedTitleId).toBeNull()
  })

  it('equipping an OWNED title succeeds and is visible in the view', async () => {
    const res = await titlePost(
      request('/api/v1/season/progression/title', players[0]!.token, 'POST', {
        titleId: 'title-season-champion',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ equippedTitleId: string | null }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.equippedTitleId).toBe('title-season-champion')

    const view = (await (
      await progressionGet(request('/api/v1/season/progression', players[0]!.token))
    ).json()) as ApiEnvelope<{ equippedTitleId: string | null }>
    expect(view.ok && view.data.equippedTitleId).toBe('title-season-champion')
  })

  it('equipping a NOT-OWNED title → 409 TITLE_NOT_OWNED (IDOR regression)', async () => {
    // players[10] holds NO title (Seasoned Warrior tier grants none).
    const res = await titlePost(
      request('/api/v1/season/progression/title', players[10]!.token, 'POST', {
        titleId: 'title-season-vanguard',
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('TITLE_NOT_OWNED')

    // Even the owner of a DIFFERENT title cannot equip one they do not hold.
    const other = await titlePost(
      request('/api/v1/season/progression/title', players[0]!.token, 'POST', {
        titleId: 'title-season-vanguard',
      }),
    )
    expect(other.status).toBe(409)
  })

  it('anonymous equip → 401; clearing with null succeeds', async () => {
    const anon = await titlePost(
      request('/api/v1/season/progression/title', null, 'POST', { titleId: null }),
    )
    expect(anon.status).toBe(401)

    const res = await titlePost(
      request('/api/v1/season/progression/title', players[0]!.token, 'POST', { titleId: null }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ equippedTitleId: string | null }>
    expect(body.ok && body.data.equippedTitleId).toBeNull()
  })
})

// ── 7. Settled history ───────────────────────────────────────────────────────

describe('GET /api/v1/season/ranking?seasonId= — materialized history', () => {
  it('serves the immutable leaderboard for the SETTLED season', async () => {
    // limit=50 lifts the default page (10) above the 12 ranked QA players.
    const res = await rankingGet(
      request(`/api/v1/season/ranking?seasonId=${settlementSeasonId}&limit=50`, players[0]!.token),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      seasonStatus: string
      live: unknown[]
      history: Array<{ rank: number; playerId: string; score: number; tier: string | null }> | null
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.seasonStatus).toBe('FINISHED')
    expect(body.data.live).toHaveLength(0)
    expect(body.data.history).toHaveLength(12)
    expect(body.data.history![0]).toMatchObject({
      rank: 1,
      playerId: players[0]!.playerId,
      score: 500,
      tier: 'Warlord Elite',
    })
  })

  it('history honors the limit (server-side page cap)', async () => {
    const res = await rankingGet(
      request(`/api/v1/season/ranking?seasonId=${settlementSeasonId}&limit=5`, players[0]!.token),
    )
    const body = (await res.json()) as ApiEnvelope<{ history: unknown[] }>
    expect(body.ok && body.data.history).toHaveLength(5)
  })

  it('unsettled season history → 409 SEASON_NOT_SETTLED · unknown season → 404', async () => {
    const active = await db.season.findFirst({
      where: { settledAt: null },
      orderBy: { number: 'desc' },
    })
    expect(active).not.toBeNull()
    const unsettled = await rankingGet(
      request(`/api/v1/season/ranking?seasonId=${active!.id}`, players[0]!.token),
    )
    expect(unsettled.status).toBe(409)
    const unsettledBody = (await unsettled.json()) as ApiEnvelope<unknown>
    if (!unsettledBody.ok) expect(unsettledBody.error.code).toBe('SEASON_NOT_SETTLED')

    const unknown = await rankingGet(
      request('/api/v1/season/ranking?seasonId=does-not-exist', players[0]!.token),
    )
    expect(unknown.status).toBe(404)
    const unknownBody = (await unknown.json()) as ApiEnvelope<unknown>
    if (!unknownBody.ok) expect(unknownBody.error.code).toBe('SEASON_NOT_FOUND')
  })
})
