/**
 * Integration tests — Phase 23 Security Audit regressions.
 *
 * Every test pins ONE fixed vulnerability end-to-end (route → guard →
 * service → transaction → DB), following the harness conventions of the
 * other suites: route handlers invoked with constructed Request objects,
 * mutations through the PUBLIC service paths, real SQLite, zero mocks.
 *
 * Vulnerability classes covered:
 *  1. CSRF defense-in-depth  — foreign-Origin POST rejected pre-auth (403),
 *                              same-origin/native pass, oversized body 413
 *  2. STAFF BAN PROTECTION   — banning an active staff member's player is a
 *                              typed refusal (was: moderator could lock an
 *                              admin out of the entire panel); self-ban too
 *  3. SETTLE CONFIRMATION    — the destructive season reset demands the
 *                              typed confirmation phrase (was: defined in
 *                              config but wired nowhere)
 *  4. PRINCIPAL RATE LIMITS  — whole-population broadcast exhausts at
 *                              5/min per identity (was: zero throttles
 *                              outside the auth group)
 *  5. ECONOMY CAS            — parallel unlocked grants all land and the
 *                              ledger reconciles exactly (was: credits were
 *                              absolute last-write-wins — a minting window)
 *  6. IDEMPOTENCY TTL        — expired grant keys re-execute per the
 *                              documented TTL and are pruned (was: forever
 *                              growing + TTL ignored)
 *  7. XP CAS                 — parallel grantors converge (was: lost-update)
 *  8. INBOX EXACTLY-ONCE     — stale-claim recovery re-delivery cannot
 *                              duplicate the inbox row (was: unguarded
 *                              read-then-create outside any transaction)
 *  9. MARK-READ IDOR         — foreign notification ids stay no-ops
 * 10. FAN-OUT CHUNKING       — 600-row fan-out crosses the chunk boundary
 *                              and stays deduped on replay (bind-parameter
 *                              ceiling defense)
 *
 * Test identities live in the isolated 9100041…/9100042… telegramId ranges
 * and are removed in afterAll (everything cascades from the user rows).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as profileGet } from '../../../src/app/api/v1/player/profile/route'
import { POST as notificationsReadPost } from '../../../src/app/api/v1/player/notifications/read/route'
import { POST as adminBanPost } from '../../../src/app/api/v1/admin/players/[id]/ban/route'
import { POST as adminSettleExecutePost } from '../../../src/app/api/v1/admin/season/settle/execute/route'
import { POST as adminAnnouncementsPost } from '../../../src/app/api/v1/admin/announcements/route'
import { POST as adminBroadcastPost } from '../../../src/app/api/v1/admin/announcements/[id]/broadcast/route'
import {
  applyResourceDeltas,
  grantResources,
  pruneExpiredIdempotencyKeys,
  getWalletBalances,
} from '../../../src/lib/game/services/economy.service'
import type { Tx } from '../../../src/lib/game/services/player-bootstrap.service'
import { withWriteRetry } from '../../../src/lib/game/services/player-registration.service'
import {
  drainNotificationQueue,
  enqueueNotificationFanOutInTx,
} from '../../../src/lib/game/services/notification.service'
import { grantXp } from '../../../src/lib/game/services/progression.service'
import { ADMIN_CONFIRMATIONS } from '../../../src/lib/game/config/admin'
import type { ApiEnvelope } from '../../../src/types/api'

// Generous transaction bounds — this suite intentionally runs UNLOCKED
// parallel transactions and a 600-row fan-out, which contend with both the
// Prisma pool and the dev server's notification worker. The default 2s
// maxWait turns that contention into flaky "Unable to start a transaction"
// failures; the suite's own assertions never depend on it.
const TEST_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

/**
 * Bounded-concurrency runner for the multi-instance simulation. Unbounded
 * parallel interactive transactions convoy on SQLite (pool connections
 * block inside BEGIN IMMEDIATE's busy-wait while the single writer
 * rotates); a small pool still runs WITHOUT the in-process wallet mutex —
 * which is the property under test (concurrent transactions racing on the
 * same row, exactly what N app instances produce).
 */
async function parallelWithLimit<T>(
  concurrency: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Security integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_BASE = '9100041'
let tgCounter = 1
const nextTgId = (): string => `${TG_BASE}${String(tgCounter++).padStart(3, '0')}`
const tgIds: string[] = []

let adminToken = ''
let adminPlayerId = ''
let moderatorToken = ''
let plainToken = ''
let plainPlayerId = ''
let secondToken = ''
let secondPlayerId = ''

let ipCounter = 1
function request(
  path: string,
  token: string | null,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': `203.0.127.${ipCounter++}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function idCtx(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
}

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `SecLord${telegramId.slice(-3)}`,
      username: `sec_lord_${telegramId.slice(-4)}`,
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

async function exchange(
  telegramId: string,
): Promise<{ token: string; userId: string; playerId: string }> {
  const res = await telegramPost(
    request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(telegramId) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as ApiEnvelope<{
    token: string
    user: { id: string }
    player: { id: string }
  }>
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error('exchange failed')
  tgIds.push(telegramId)
  return { token: body.data.token, userId: body.data.user.id, playerId: body.data.player.id }
}

beforeAll(async () => {
  // Self-healing: a previous run that crashed before afterAll leaves residue
  // in the 910004… ranges — re-running the suite re-attaches to the SAME
  // users (upsert by telegramId) and would collide on unique fixtures.
  // Restrict-referencing children go first, then the identity range
  // (players, wallets, ledger, sessions, notifications… cascade).
  const residue = await db.user.findMany({
    where: { telegramId: { startsWith: '910004' } },
    select: { id: true },
  })
  const residueIds = residue.map((u) => u.id)
  if (residueIds.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: residueIds } } })
    await db.announcement.deleteMany({ where: { createdById: { in: residueIds } } })
    await db.adminUser.deleteMany({ where: { userId: { in: residueIds } } })
    await db.user.deleteMany({ where: { telegramId: { startsWith: '910004' } } })
  }

  // Staff fixtures: an ADMIN and a MODERATOR (DB rows are the authority).
  const admin = await exchange(nextTgId())
  adminToken = admin.token
  adminPlayerId = admin.playerId
  await db.adminUser.create({ data: { userId: admin.userId, role: 'ADMIN', isActive: true } })
  const moderator = await exchange(nextTgId())
  moderatorToken = moderator.token
  await db.adminUser.create({
    data: { userId: moderator.userId, role: 'MODERATOR', isActive: true },
  })
  const plain = await exchange(nextTgId())
  plainToken = plain.token
  plainPlayerId = plain.playerId
  const second = await exchange(nextTgId())
  secondToken = second.token
  secondPlayerId = second.playerId
})

afterAll(async () => {
  const users = await db.user.findMany({
    where: { telegramId: { startsWith: '910004' } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  await db.adminUser.deleteMany({ where: { userId: { in: userIds } } })
  // Explicit child cleanup (keys/ledger have no cascade guarantee), then
  // the identity range cascades players, wallets, notifications, sessions…
  const players = await db.player.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  })
  const playerIds = players.map((p) => p.id)
  await db.idempotencyKey.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.resourceTransaction.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.notification.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.notificationQueue.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.announcement.deleteMany({ where: { createdById: { in: userIds } } })
  await db.user.deleteMany({ where: { telegramId: { startsWith: '910004' } } })
})

async function envelope(res: Response): Promise<ApiEnvelope<Record<string, unknown>>> {
  return (await res.json()) as ApiEnvelope<Record<string, unknown>>
}

// ── 1. Transport hardening ───────────────────────────────────────────────────

describe('transport hardening (CSRF defense-in-depth, body cap)', () => {
  it('rejects a foreign-Origin POST pre-auth with FORBIDDEN_ORIGIN 403', async () => {
    const res = await telegramPost(
      request(
        '/api/v1/auth/telegram',
        null,
        'POST',
        { initData: 'x' },
        { origin: 'https://evil.example' },
      ),
    )
    expect(res.status).toBe(403)
    const body = await envelope(res)
    expect(body.ok).toBe(false)
    expect((body as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('GET is unaffected by the Origin guard; POST on an authed route still fires it', async () => {
    const get = await profileGet(
      request('/api/v1/player/profile', plainToken, 'GET', undefined, {
        origin: 'https://evil.example',
      }),
    )
    expect(get.status).toBe(200)
    const post = await telegramPost(
      request(
        '/api/v1/auth/telegram',
        plainToken,
        'POST',
        { initData: 'x' },
        { origin: 'https://evil.example' },
      ),
    )
    expect(post.status).toBe(403)
  })

  it('allows a same-origin POST (the Mini App fetch path)', async () => {
    const res = await telegramPost(
      request(
        '/api/v1/auth/telegram',
        null,
        'POST',
        { initData: 'x' },
        { origin: 'http://localhost:3000' },
      ),
    )
    // Bad initData → 401 INVALID_INIT_DATA — proves the origin guard passed.
    expect(res.status).toBe(401)
    const body = await envelope(res)
    expect((body as { error: { code: string } }).error.code).not.toBe('FORBIDDEN_ORIGIN')
  })

  it('rejects an oversized body with BODY_TOO_LARGE 413 before any processing', async () => {
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: 'x'.repeat(70_000) }),
      }),
    )
    expect(res.status).toBe(413)
    const body = await envelope(res)
    expect((body as { error: { code: string } }).error.code).toBe('BODY_TOO_LARGE')
  })
})

// ── 2. Staff ban protection ──────────────────────────────────────────────────

describe('staff ban protection (privilege-escalation fix)', () => {
  it('refuses to ban a player belonging to an ACTIVE staff member (PROTECTED_TARGET)', async () => {
    // A MODERATOR attempting to ban the ADMIN's player — previously this
    // succeeded and locked the admin out of every admin route (the ban
    // check runs on EVERY authenticated request).
    const res = await adminBanPost(
      request('/api/v1/admin/players/x/ban', moderatorToken, 'POST', {
        reason: 'moderator abusing ban path against staff',
      }),
      idCtx(adminPlayerId),
    )
    expect(res.status).toBe(403)
    const body = await envelope(res)
    expect((body as { error: { code: string } }).error.code).toBe('PROTECTED_TARGET')

    const target = await db.user.findFirst({
      where: { player: { id: adminPlayerId } },
      select: { isBanned: true },
    })
    expect(target?.isBanned).toBe(false)
  })

  it('ALLOWS banning a player whose staff record is INACTIVE (access already revoked)', async () => {
    // Boundary of the protection: an INACTIVE AdminUser row means the
    // account holds no live staff access (and cannot self-restore it), so
    // it is a normal player for moderation purposes. Banning it is legal
    // and must NOT be refused.
    const target = await exchange(nextTgId())
    await db.adminUser.create({
      data: { userId: target.userId, role: 'MODERATOR', isActive: false },
    })
    const res = await adminBanPost(
      request('/api/v1/admin/players/x/ban', adminToken, 'POST', {
        reason: 'admin banning a former moderator account',
      }),
      idCtx(target.playerId),
    )
    expect(res.status).toBe(200)
    const banned = await db.user.findFirst({
      where: { player: { id: target.playerId } },
      select: { isBanned: true },
    })
    expect(banned?.isBanned).toBe(true)
    // Restore for the afterAll cleanup path.
    await db.user.updateMany({
      where: { player: { id: target.playerId } },
      data: { isBanned: false, banReason: null, bannedAt: null, banExpiresAt: null },
    })
  })

  it('refuses self-ban — the admin rail fires first, target untouched', async () => {
    const res = await adminBanPost(
      request('/api/v1/admin/players/x/ban', adminToken, 'POST', {
        reason: 'admin attempting to ban themself',
      }),
      idCtx(adminPlayerId),
    )
    expect(res.status).toBe(403)
    const target = await db.user.findFirst({
      where: { player: { id: adminPlayerId } },
      select: { isBanned: true },
    })
    expect(target?.isBanned).toBe(false)
  })
})

// ── 3. Season settle confirmation ────────────────────────────────────────────

describe('season settle destructive-op confirmation', () => {
  it('rejects execute without the typed confirmation phrase (400, pre-handler)', async () => {
    const res = await adminSettleExecutePost(
      request('/api/v1/admin/season/settle/execute', adminToken, 'POST', { seasonNumber: 1 }),
    )
    expect(res.status).toBe(400)
    const body = await envelope(res)
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    const issues = (body as { error: { details?: { issues?: Array<{ path: string }> } } }).error
      .details?.issues
    expect((issues ?? []).map((i) => i.path)).toContain('confirm')
  })

  it('rejects execute with a WRONG confirmation phrase', async () => {
    const res = await adminSettleExecutePost(
      request('/api/v1/admin/season/settle/execute', adminToken, 'POST', {
        seasonNumber: 1,
        confirm: 'reset the season please',
      }),
    )
    expect(res.status).toBe(400)
    const body = await envelope(res)
    expect((body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('exports the wired phrase the route demands (config ↔ route coherence)', () => {
    expect(ADMIN_CONFIRMATIONS.seasonSettle).toBe('RESET SEASON')
  })
})

// ── 4. Principal rate limits ─────────────────────────────────────────────────

describe('principal rate limits (identity-keyed, unforgeable)', () => {
  it('exhausts the broadcast budget (5/min) and refuses the 6th with RATE_LIMITED 429', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      // Announcements are born ACTIVE (isActive default) — broadcast straight
      // away; the active-toggle is only for the deactivate rail, not needed
      // for the fan-out path under test here.
      const created = await adminAnnouncementsPost(
        request('/api/v1/admin/announcements', adminToken, 'POST', {
          title: `Security broadcast ${i + 1}`,
          body: 'Rate-limit regression broadcast body for the security suite.',
          audience: 'ALL',
        }),
      )
      expect(created.status).toBe(200)
      const createdBody = await envelope(created)
      const announcementId = (createdBody.data as { id: string }).id
      ids.push(announcementId)
    }

    for (const id of ids) {
      const res = await adminBroadcastPost(
        request('/api/v1/admin/announcements/x/broadcast', adminToken, 'POST', {}),
        idCtx(id),
      )
      expect(res.status).toBe(200)
    }
    const sixth = await adminBroadcastPost(
      request('/api/v1/admin/announcements/x/broadcast', adminToken, 'POST', {}),
      idCtx(ids[0]!),
    )
    expect(sixth.status).toBe(429)
    const body = await envelope(sixth)
    expect((body as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
  })
})

// ── 5. Economy compare-and-set credits ───────────────────────────────────────

describe('economy CAS credits (money-printing fix)', () => {
  it('all parallel UNLOCKED grants land and the ledger reconciles exactly', async () => {
    const before = await getWalletBalances(db, plainPlayerId)
    const grants = 12
    const perGrant = 100n

    // Parallel transactions WITHOUT the per-player mutex — the multi-
    // instance simulation at bounded concurrency (above the pool size the
    // convoy would starve the pool; below it the races still interleave).
    // withWriteRetry absorbs SQLite BUSY.
    await parallelWithLimit(
      2,
      Array.from(
        { length: grants },
        () => () =>
          withWriteRetry(() =>
            db.$transaction(
              (tx: Tx) =>
                applyResourceDeltas(tx, plainPlayerId, [{ resource: 'GOLD', delta: perGrant }], {
                  reason: 'ADMIN_ADJUSTMENT',
                  refType: 'security-test',
                }),
              TEST_TX_OPTIONS,
            ),
          ),
      ),
    )

    const after = await getWalletBalances(db, plainPlayerId)
    expect(after.GOLD).toBe(before.GOLD + BigInt(grants) * perGrant)

    // THE invariant: Σ(ledger delta) == stored balance change. The pre-fix
    // last-write-wins credit could break exactly this (balance explained by
    // less ledger than it holds = minted resources).
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: plainPlayerId, resource: 'GOLD', refType: 'security-test' },
      select: { delta: true },
    })
    const ledgerSum = ledger.reduce((acc, row) => acc + row.delta, 0n)
    expect(ledgerSum).toBe(BigInt(grants) * perGrant)
  })

  it('mixed parallel credits and debits converge with ledger reconciliation', async () => {
    const before = await getWalletBalances(db, secondPlayerId)
    await parallelWithLimit(2, [
      ...Array.from(
        { length: 6 },
        () => () =>
          withWriteRetry(() =>
            db.$transaction(
              (tx: Tx) =>
                applyResourceDeltas(tx, secondPlayerId, [{ resource: 'WOOD', delta: 100n }], {
                  reason: 'ADMIN_ADJUSTMENT',
                  refType: 'security-test-mixed',
                }),
              TEST_TX_OPTIONS,
            ),
          ),
      ),
      ...Array.from(
        { length: 6 },
        () => () =>
          withWriteRetry(() =>
            db.$transaction(
              (tx: Tx) =>
                applyResourceDeltas(tx, secondPlayerId, [{ resource: 'WOOD', delta: -50n }], {
                  reason: 'ADMIN_ADJUSTMENT',
                  refType: 'security-test-mixed',
                }),
              TEST_TX_OPTIONS,
            ),
          ),
      ),
    ])
    const after = await getWalletBalances(db, secondPlayerId)
    expect(after.WOOD).toBe(before.WOOD + 6n * 100n - 6n * 50n)
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: secondPlayerId, resource: 'WOOD', refType: 'security-test-mixed' },
      select: { delta: true },
    })
    expect(ledger.reduce((acc, row) => acc + row.delta, 0n)).toBe(300n)
  })
})

// ── 6. Idempotency key TTL ───────────────────────────────────────────────────

describe('grant idempotency TTL (unbounded-growth fix)', () => {
  it('a live key replays the original payout; an EXPIRED key re-executes per the documented TTL', async () => {
    const amounts = { IRON: 777n }
    const opts = {
      reason: 'ADMIN_ADJUSTMENT' as const,
      idempotencyKey: 'sec-ttl-key-1',
      refType: 'security-ttl',
    }
    const first = await db.$transaction(
      (tx: Tx) => grantResources(tx, plainPlayerId, amounts, opts),
      TEST_TX_OPTIONS,
    )
    expect(first.replayed).toBe(false)

    const replay = await db.$transaction(
      (tx: Tx) => grantResources(tx, plainPlayerId, amounts, opts),
      TEST_TX_OPTIONS,
    )
    expect(replay.replayed).toBe(true)

    // Expire the key, then replay: documented TTL semantics — the grant
    // re-executes (fresh payout, replayed:false).
    await db.idempotencyKey.update({
      where: { key: 'sec-ttl-key-1' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const afterExpiry = await db.$transaction(
      (tx: Tx) => grantResources(tx, plainPlayerId, amounts, opts),
      TEST_TX_OPTIONS,
    )
    expect(afterExpiry.replayed).toBe(false)
    const balance = await getWalletBalances(db, plainPlayerId)
    expect(balance.IRON).toBeGreaterThanOrEqual(777n * 2n)
  })

  it('pruneExpiredIdempotencyKeys deletes ONLY expired keys', async () => {
    await db.$transaction(
      (tx: Tx) =>
        grantResources(
          tx,
          plainPlayerId,
          { FOOD: 10n },
          {
            reason: 'ADMIN_ADJUSTMENT',
            idempotencyKey: 'sec-ttl-fresh',
            refType: 'security-ttl-prune',
          },
        ),
      TEST_TX_OPTIONS,
    )
    await db.idempotencyKey.update({
      where: { key: 'sec-ttl-key-1' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })
    const pruned = await pruneExpiredIdempotencyKeys(new Date())
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect(await db.idempotencyKey.findUnique({ where: { key: 'sec-ttl-fresh' } })).not.toBeNull()
    expect(await db.idempotencyKey.findUnique({ where: { key: 'sec-ttl-key-1' } })).toBeNull()
  })
})

// ── 7. XP compare-and-set ────────────────────────────────────────────────────

describe('grantXp CAS (lost-update fix)', () => {
  it('all parallel grantors land — final xp equals the full sum', async () => {
    const target = await exchange(nextTgId())
    const grants = 10
    const perGrant = 10
    await parallelWithLimit(
      2,
      Array.from(
        { length: grants },
        () => () =>
          withWriteRetry(() =>
            db.$transaction(
              (tx: Tx) =>
                grantXp(tx, {
                  playerId: target.playerId,
                  amount: perGrant,
                  source: 'security-suite',
                }),
              TEST_TX_OPTIONS,
            ),
          ),
      ),
    )
    const player = await db.player.findUniqueOrThrow({
      where: { id: target.playerId },
      select: { xp: true, level: true },
    })
    expect(Number(player.xp)).toBe(grants * perGrant)
    expect(player.level).toBeGreaterThanOrEqual(1)
  })
})

// ── 8. Inbox exactly-once across stale-claim recovery ────────────────────────

describe('notification inbox exactly-once (stale-claim duplicate-delivery fix)', () => {
  it('re-delivery after a stale claim reuses the backlink — inbox row count stays 1', async () => {
    // Every freshly registered player has exactly one queued welcome notice.
    const queueRow = await db.notificationQueue.findFirstOrThrow({
      where: { playerId: plainPlayerId },
      orderBy: { createdAt: 'asc' },
    })

    // Simulate worker crash #1: the row sits in PROCESSING past the stale
    // window (the ghost claim is what stale-claim recovery exists for).
    const staleAt = new Date(Date.now() - 10 * 60 * 1000)
    await db.notificationQueue.update({
      where: { id: queueRow.id },
      data: { status: 'PROCESSING', claimedAt: staleAt, claimedBy: 'ghost-1' },
    })
    const drain1 = await drainNotificationQueue({
      workerId: 'security-suite',
      telegramConfig: { token: null },
    })
    expect(drain1.sent).toBeGreaterThanOrEqual(1)
    const afterFirst = await db.notificationQueue.findUniqueOrThrow({
      where: { id: queueRow.id },
    })
    expect(afterFirst.status).toBe('SENT')
    expect(afterFirst.notificationId).not.toBeNull()
    // Scoped to THIS queue row's type: other tests in the suite broadcast
    // ANNOUNCEMENT rows to the same player — only same-type rows count.
    const inbox1 = await db.notification.findMany({
      where: { playerId: plainPlayerId, type: queueRow.type },
    })
    expect(inbox1.length).toBe(1)

    // Simulate crash #2 ON THE DELIVERED ROW: force it back into a stale
    // PROCESSING state with the backlink SET — the exact window where the
    // pre-fix code created a SECOND inbox row. The re-claiming worker must
    // reuse the existing backlink.
    await db.notificationQueue.update({
      where: { id: queueRow.id },
      data: { status: 'PROCESSING', claimedAt: staleAt, claimedBy: 'ghost-2' },
    })
    const drain2 = await drainNotificationQueue({
      workerId: 'security-suite',
      telegramConfig: { token: null },
    })
    expect(drain2.sent).toBeGreaterThanOrEqual(1)
    const inbox2 = await db.notification.findMany({
      where: { playerId: plainPlayerId, type: queueRow.type },
    })
    expect(inbox2.length).toBe(1) // ← the regression: was 2
    const finalRow = await db.notificationQueue.findUniqueOrThrow({
      where: { id: queueRow.id },
    })
    expect(finalRow.notificationId).toBe(inbox1[0]!.id)
  })
})

// ── 9. Mark-read IDOR regression ─────────────────────────────────────────────

describe('mark-read IDOR (foreign notification ids are no-ops)', () => {
  it('player A cannot mark player B notification read; own rows work', async () => {
    const foreign = await db.notification.findFirstOrThrow({
      where: { playerId: plainPlayerId },
      select: { id: true },
    })
    // Second player attempts to read the first player's notification.
    const res = await notificationsReadPost(
      request('/api/v1/player/notifications/read', secondToken, 'POST', {
        ids: [foreign.id],
      }),
    )
    expect(res.status).toBe(200)
    const body = await envelope(res)
    expect((body.data as { updated: number }).updated).toBe(0)
    const stillUnread = await db.notification.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { isRead: true },
    })
    expect(stillUnread.isRead).toBe(false)

    // Own rows mark fine.
    const own = await notificationsReadPost(
      request('/api/v1/player/notifications/read', plainToken, 'POST', { all: true }),
    )
    expect(own.status).toBe(200)
    const ownBody = await envelope(own)
    expect((ownBody.data as { updated: number }).updated).toBeGreaterThanOrEqual(1)
  })
})

// ── 10. Fan-out chunking ─────────────────────────────────────────────────────

describe('notification fan-out chunking (bind-parameter ceiling defense)', () => {
  it('a 600-player fan-out crosses chunk boundaries, stays deduped on replay', async () => {
    // Minimal identities (users + players) — no city/army bootstrap.
    const bulkBase = '9100042'
    const bulkCount = 600
    const bulkIds: string[] = []
    for (let i = 1; i <= bulkCount; i++) bulkIds.push(`${bulkBase}${String(i).padStart(3, '0')}`)

    const users = await db.user.createMany({
      data: bulkIds.map((telegramId, i) => ({ telegramId, firstName: `Bulk${i}` })),
    })
    expect(users.count).toBe(bulkCount)
    const created = await db.user.findMany({
      where: { telegramId: { in: bulkIds } },
      select: { id: true },
    })
    await db.player.createMany({
      data: created.map((u) => ({ userId: u.id, name: `BulkLord${u.id.slice(-4)}` })),
    })
    const players = await db.player.findMany({
      where: { userId: { in: created.map((u) => u.id) } },
      select: { id: true },
    })
    expect(players.length).toBe(bulkCount)

    const fanOutInput = {
      type: 'EVENT' as const,
      dedupeKeyFor: () => 'security-suite:bulk-event',
      payloadFor: () => ({
        eventId: 'security-bulk-event',
        title: 'Security bulk event',
        body: 'Fan-out chunking regression across the 500-row boundary.',
      }),
      channels: ['IN_APP' as const],
    }

    const inserted = await db.$transaction(
      (tx: Tx) =>
        enqueueNotificationFanOutInTx(
          tx,
          players.map((p) => p.id),
          fanOutInput,
        ),
      TEST_TX_OPTIONS,
    )
    expect(inserted).toBe(bulkCount)

    const replay = await db.$transaction(
      (tx: Tx) =>
        enqueueNotificationFanOutInTx(
          tx,
          players.map((p) => p.id),
          fanOutInput,
        ),
      TEST_TX_OPTIONS,
    )
    expect(replay).toBe(0) // deduped — a replayed broadcast cannot re-notify

    // Self-clean the 600 queue rows so later suites' bounded drain batches
    // are never consumed by this suite's rows.
    await db.notificationQueue.deleteMany({
      where: { type: 'EVENT', dedupeKey: 'security-suite:bulk-event' },
    })
  })
})
