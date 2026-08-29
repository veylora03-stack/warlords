/**
 * Integration tests — Economy Engine (Phase 5): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → services → transactions → envelope). Economy
 * mutations are exercised through the PUBLIC service paths (the same ones
 * future subsystems call) wrapped in real transactions — real BigInt math,
 * real SQLite, zero mocks.
 *
 * Required scenarios (user contract):
 *  1. NEGATIVE RESOURCE     — debits beyond balance fail typed (409), balances
 *                             never go negative, invalid deltas rejected
 *  2. DUPLICATE REWARD      — idempotency-keyed grants pay exactly once
 *  3. CONCURRENT UPDATE     — parallel mixed ops converge exactly; contended
 *                             debits produce exactly one winner; ledger reconciles
 *  4. OVERFLOW              — credits clamp exactly at the configured cap,
 *                             ledger keeps reconciling
 *  5. UNAUTHORIZED UPDATE   — economy surface is GET-only + 401 without a
 *                             valid session + strict per-player isolation
 *  6. TRANSACTION ROLLBACK  — a failing batch persists nothing (balances,
 *                             ledger, idempotency keys); crash-after-grant
 *                             leaves zero residue
 *
 * Test identities live in the isolated 9100005… telegramId range and are
 * removed in afterAll (cascades: player, wallet, ledger, sessions…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as resourcesGet } from '../../../src/app/api/v1/player/resources/route'
import { GET as transactionsGet } from '../../../src/app/api/v1/player/transactions/route'
import * as resourcesRouteModule from '../../../src/app/api/v1/player/resources/route'
import * as transactionsRouteModule from '../../../src/app/api/v1/player/transactions/route'
import { AppError } from '../../../src/lib/api/errors'
import {
  adminAdjustResources,
  applyResourceDeltas,
  getTransactionHistory,
  getWalletBalances,
  getWalletView,
  grantResources,
  runEconomyTransaction,
  spendResources,
} from '../../../src/lib/game/services/economy.service'
import { RESOURCE_CAPS } from '../../../src/lib/game/config/economy'
import { STARTER_WALLET } from '../../../src/lib/game/config/starter'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Economy integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '203.0.115.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100005001
const nextTgId = (): string => String(tgCounter++)

function telegramRequest(initData: string): Request {
  return new Request('http://localhost:3000/api/v1/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ initData }),
  })
}

function buildInitData(telegramId: string, seq = 0): string {
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAA${telegramId.slice(-4)}${seq}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60 - seq),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `EconLord${telegramId.slice(-3)}`,
      username: `econ_lord_${telegramId.slice(-4)}`,
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

function authedGet(path: string, token: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
  })
}

interface WalletViewData {
  playerId: string
  resources: Array<{ key: string; balance: string; cap: string; headroom: string }>
  updatedAt: string
}

interface LedgerEntryData {
  id: string
  resource: string
  delta: string
  balanceAfter: string
  reason: string
  refType: string | null
  refId: string | null
  metadata: unknown
  createdAt: string
}

interface LedgerPageData {
  entries: LedgerEntryData[]
  nextCursor: string | null
  hasMore: boolean
}

async function parse<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

async function exchange(
  tgId: string,
): Promise<{ token: string; playerId: string; userId: string }> {
  const res = await telegramPost(telegramRequest(buildInitData(tgId)))
  expect(res.status).toBe(200)
  const body = await parse<{ token: string; user: { id: string }; player: { id: string } | null }>(
    res,
  )
  expect(body.ok).toBe(true)
  if (!body.ok || !body.data.player) throw new Error('exchange did not return a player')
  return { token: body.data.token, playerId: body.data.player.id, userId: body.data.user.id }
}

async function expectAppError(run: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await run()
  } catch (err) {
    if (err instanceof AppError && err.code === code) return err
    throw new Error(`expected AppError ${code}, got: ${String(err)}`)
  }
  throw new Error(`expected AppError ${code}, but the call succeeded`)
}

/** Ledger-first invariant: Σ(delta) per resource == stored balance. */
async function reconcileLedger(playerId: string): Promise<void> {
  const balances = await getWalletBalances(db, playerId)
  const grouped = await db.resourceTransaction.groupBy({
    by: ['resource'],
    where: { playerId },
    _sum: { delta: true },
  })
  const sums = new Map(grouped.map((row) => [row.resource, row._sum.delta ?? 0n]))
  for (const [resource, balance] of Object.entries(balances)) {
    const sum = sums.get(resource) ?? 0n
    expect(sum).toBe(balance)
    expect(balance >= 0n).toBeTrue() // no-negative invariant on every resource
  }
}

// ── Shared fixtures (created once) ───────────────────────────────────────────

const walletTgId = nextTgId()
const negTgId = nextTgId()
const dupTgId = nextTgId()
const concTgId = nextTgId()
const overTgId = nextTgId()
const isoATgId = nextTgId()
const isoBTgId = nextTgId()
const rollTgId = nextTgId()
const adminTgId = nextTgId()

let walletPlayerId = ''
let walletToken = ''
let negPlayerId = ''
let dupPlayerId = ''
let concPlayerId = ''
let overPlayerId = ''
let isoAPlayerId = ''
let isoAToken = ''
let isoBPlayerId = ''
let rollPlayerId = ''
let adminUserId = ''

beforeAll(async () => {
  const wallet = await exchange(walletTgId)
  walletPlayerId = wallet.playerId
  walletToken = wallet.token

  negPlayerId = (await exchange(negTgId)).playerId
  dupPlayerId = (await exchange(dupTgId)).playerId
  concPlayerId = (await exchange(concTgId)).playerId
  overPlayerId = (await exchange(overTgId)).playerId
  rollPlayerId = (await exchange(rollTgId)).playerId

  const isoA = await exchange(isoATgId)
  isoAPlayerId = isoA.playerId
  isoAToken = isoA.token
  isoBPlayerId = (await exchange(isoBTgId)).playerId

  // A real operator user for the audited admin-adjustment path.
  adminUserId = (
    await db.user.create({
      data: { telegramId: adminTgId, firstName: 'EconAdmin', role: 'ADMIN' },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  // Audit rows (Restrict FK to actor) → idempotency keys (playerId, no FK) → users (cascade).
  await db.auditLog.deleteMany({ where: { actorUserId: adminUserId } })
  await db.idempotencyKey.deleteMany({ where: { playerId: { in: [dupPlayerId, rollPlayerId] } } })
  await db.user.deleteMany({ where: { telegramId: { startsWith: '9100005' } } })
})

// ── 1. Wallet view (read API) ────────────────────────────────────────────────

describe('GET /api/v1/player/resources (wallet view)', () => {
  it('projects all six resources with starter balances, caps and headroom', async () => {
    const res = await resourcesGet(authedGet('/api/v1/player/resources', walletToken))
    expect(res.status).toBe(200)
    const body = await parse<WalletViewData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.playerId).toBe(walletPlayerId)
    expect(body.data.resources.map((r) => r.key)).toEqual([
      'GOLD',
      'WOOD',
      'IRON',
      'FOOD',
      'CRYSTAL',
      'GEMS',
    ])

    const byKey = new Map(body.data.resources.map((r) => [r.key, r]))
    expect(byKey.get('GOLD')?.balance).toBe(String(STARTER_WALLET.GOLD))
    expect(byKey.get('WOOD')?.balance).toBe(String(STARTER_WALLET.WOOD))
    expect(byKey.get('IRON')?.balance).toBe(String(STARTER_WALLET.IRON))
    expect(byKey.get('FOOD')?.balance).toBe(String(STARTER_WALLET.FOOD))
    expect(byKey.get('CRYSTAL')?.balance).toBe(String(STARTER_WALLET.CRYSTAL))
    expect(byKey.get('GEMS')?.balance).toBe('0') // premium currency starts empty

    for (const entry of body.data.resources) {
      const cap = RESOURCE_CAPS[entry.key as keyof typeof RESOURCE_CAPS]
      expect(entry.cap).toBe(cap.toString())
      expect(entry.headroom).toBe((cap - BigInt(entry.balance)).toString())
    }
  })
})

// ── 2. NEGATIVE RESOURCE — debits are balance-guarded, inputs validated ──────

describe('negative resource protection', () => {
  it('refuses a spend beyond the balance with a typed 409 and writes nothing', async () => {
    const before = await getWalletBalances(db, negPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: negPlayerId } })

    const err = await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          spendResources(
            tx,
            negPlayerId,
            { GOLD: BigInt(STARTER_WALLET.GOLD) * 1000n },
            { reason: 'UNIT_TRAINING' },
          ),
        ),
      'INSUFFICIENT_GOLD',
    )
    expect(err.httpStatus).toBe(409)
    expect(err.details?.['have']).toBe(STARTER_WALLET.GOLD)

    const after = await getWalletBalances(db, negPlayerId)
    expect(after).toEqual(before)
    expect(await db.resourceTransaction.count({ where: { playerId: negPlayerId } })).toBe(
      ledgerBefore,
    )
  })

  it('allows spending down to exactly zero — never below', async () => {
    // CRYSTAL starter is 20 — spend it all, then prove one more unit fails.
    await runEconomyTransaction(negPlayerId, (tx) =>
      spendResources(
        tx,
        negPlayerId,
        { CRYSTAL: BigInt(STARTER_WALLET.CRYSTAL) },
        { reason: 'MARKET_PURCHASE' },
      ),
    )
    const after = await getWalletBalances(db, negPlayerId)
    expect(after['CRYSTAL']).toBe(0n)

    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          spendResources(tx, negPlayerId, { CRYSTAL: 1n }, { reason: 'MARKET_PURCHASE' }),
        ),
      'INSUFFICIENT_CRYSTAL',
    )
    await reconcileLedger(negPlayerId)
  })

  it('rejects non-positive, non-BigInt and oversized grant amounts', async () => {
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          grantResources(tx, negPlayerId, { GOLD: -100n }, { reason: 'QUEST_REWARD' }),
        ),
      'INVALID_AMOUNT',
    )
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          grantResources(tx, negPlayerId, { GOLD: 0n }, { reason: 'QUEST_REWARD' }),
        ),
      'INVALID_AMOUNT',
    )
    // A plain number (float channel) — rejected even if mathematically integral.
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          grantResources(
            tx,
            negPlayerId,
            { GOLD: 500 as unknown as bigint },
            { reason: 'QUEST_REWARD' },
          ),
        ),
      'INVALID_AMOUNT',
    )
  })

  it('rejects unknown resources, unknown reasons and duplicate batch entries', async () => {
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          applyResourceDeltas(tx, negPlayerId, [{ resource: 'MANA' as never, delta: 5n }], {
            reason: 'QUEST_REWARD',
          }),
        ),
      'VALIDATION_ERROR',
    )
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          applyResourceDeltas(tx, negPlayerId, [{ resource: 'GOLD', delta: 5n }], {
            reason: 'FREE_COINS' as never,
          }),
        ),
      'VALIDATION_ERROR',
    )
    await expectAppError(
      () =>
        runEconomyTransaction(negPlayerId, (tx) =>
          applyResourceDeltas(
            tx,
            negPlayerId,
            [
              { resource: 'GOLD', delta: 5n },
              { resource: 'GOLD', delta: 6n },
            ],
            { reason: 'QUEST_REWARD' },
          ),
        ),
      'VALIDATION_ERROR',
    )
  })
})

// ── 3. DUPLICATE REWARD — idempotency keys pay exactly once ──────────────────

describe('duplicate reward protection (idempotent grants)', () => {
  it('pays once; the replayed grant returns the original result without paying again', async () => {
    const key = `econ-test-quest-${dupTgId}`
    const before = await getWalletBalances(db, dupPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: dupPlayerId } })

    const first = await runEconomyTransaction(dupPlayerId, (tx) =>
      grantResources(
        tx,
        dupPlayerId,
        { GOLD: 500n },
        { reason: 'QUEST_REWARD', idempotencyKey: key },
      ),
    )
    expect(first.replayed).toBeFalse()
    const goldEntry = first.applied.find((entry) => entry.resource === 'GOLD')
    expect(goldEntry?.appliedDelta).toBe(500n)
    expect(goldEntry?.balanceAfter).toBe(before['GOLD'] + 500n)

    // Retried / double-clicked claim with the SAME key + payload:
    const second = await runEconomyTransaction(dupPlayerId, (tx) =>
      grantResources(
        tx,
        dupPlayerId,
        { GOLD: 500n },
        { reason: 'QUEST_REWARD', idempotencyKey: key },
      ),
    )
    expect(second.replayed).toBeTrue()
    expect(second.applied).toEqual(first.applied)

    const after = await getWalletBalances(db, dupPlayerId)
    expect(after['GOLD']).toBe(before['GOLD'] + 500n) // paid exactly once
    expect(await db.resourceTransaction.count({ where: { playerId: dupPlayerId } })).toBe(
      ledgerBefore + 1,
    )
    await reconcileLedger(dupPlayerId)
  })

  it('rejects an idempotency key reused with a different payload', async () => {
    const key = `econ-test-quest-${dupTgId}`
    await expectAppError(
      () =>
        runEconomyTransaction(dupPlayerId, (tx) =>
          grantResources(
            tx,
            dupPlayerId,
            { GOLD: 999n },
            { reason: 'QUEST_REWARD', idempotencyKey: key },
          ),
        ),
      'IDEMPOTENT_REPLAY',
    )
  })

  it('different keys grant independently (no false-positive dedup)', async () => {
    const before = await getWalletBalances(db, dupPlayerId)
    await runEconomyTransaction(dupPlayerId, (tx) =>
      grantResources(
        tx,
        dupPlayerId,
        { GEMS: 5n },
        {
          reason: 'BATTLE_REWARD',
          idempotencyKey: `econ-test-battle-${dupTgId}-1`,
        },
      ),
    )
    await runEconomyTransaction(dupPlayerId, (tx) =>
      grantResources(
        tx,
        dupPlayerId,
        { GEMS: 5n },
        {
          reason: 'BATTLE_REWARD',
          idempotencyKey: `econ-test-battle-${dupTgId}-2`,
        },
      ),
    )
    const after = await getWalletBalances(db, dupPlayerId)
    expect(after['GEMS']).toBe(before['GEMS'] + 10n)
  })

  it('rejects malformed idempotency keys', async () => {
    await expectAppError(
      () =>
        runEconomyTransaction(dupPlayerId, (tx) =>
          grantResources(
            tx,
            dupPlayerId,
            { GOLD: 1n },
            { reason: 'QUEST_REWARD', idempotencyKey: '' },
          ),
        ),
      'VALIDATION_ERROR',
    )
  })
})

// ── 4. CONCURRENT UPDATE — parallel ops converge exactly ─────────────────────

describe('concurrent updates (race conditions)', () => {
  it('parallel mixed credits/debits converge to the exact expected balance', async () => {
    const start = await getWalletBalances(db, concPlayerId)
    const startGold = start['GOLD']

    const ops: Array<Promise<unknown>> = []
    for (let i = 0; i < 6; i++) {
      ops.push(
        runEconomyTransaction(concPlayerId, (tx) =>
          grantResources(
            tx,
            concPlayerId,
            { GOLD: 100n },
            {
              reason: 'QUEST_REWARD',
              refType: 'quest',
              refId: `concurrent-credit-${i}`,
            },
          ),
        ),
      )
      ops.push(
        runEconomyTransaction(concPlayerId, (tx) =>
          spendResources(
            tx,
            concPlayerId,
            { GOLD: 50n },
            {
              reason: 'UNIT_TRAINING',
              refType: 'unit',
              refId: `concurrent-debit-${i}`,
            },
          ),
        ),
      )
    }
    await Promise.all(ops)

    const end = await getWalletBalances(db, concPlayerId)
    expect(end['GOLD']).toBe(startGold + 600n - 300n)
    await reconcileLedger(concPlayerId)
  })

  it('contended debits on a limited balance produce exactly one winner', async () => {
    // Balance is ≥1500; three parallel 1000-gold spends can fit at most once.
    const start = (await getWalletBalances(db, concPlayerId))['GOLD']
    const attempts = [1, 2, 3].map((n) =>
      runEconomyTransaction(concPlayerId, (tx) =>
        spendResources(
          tx,
          concPlayerId,
          { GOLD: 1000n },
          {
            reason: 'BUILDING_UPGRADE',
            refType: 'building',
            refId: `contended-${n}`,
          },
        ),
      ).then(
        () => 'won' as const,
        (err) => {
          if (err instanceof AppError && err.code === 'INSUFFICIENT_GOLD') return 'lost' as const
          throw err
        },
      ),
    )
    const outcomes = await Promise.all(attempts)

    expect(outcomes.filter((o) => o === 'won').length).toBe(1)
    expect(outcomes.filter((o) => o === 'lost').length).toBe(2)
    expect((await getWalletBalances(db, concPlayerId))['GOLD']).toBe(start - 1000n)
    await reconcileLedger(concPlayerId)
  })

  it('concurrent GEMS credits on the Player row reconcile through the same ledger', async () => {
    const start = (await getWalletBalances(db, concPlayerId))['GEMS']
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        runEconomyTransaction(concPlayerId, (tx) =>
          grantResources(
            tx,
            concPlayerId,
            { GEMS: 3n },
            {
              reason: 'ADMIN_ADJUSTMENT',
              refId: `gems-${n}`,
              metadata: { note: 'concurrent test' },
            },
          ),
        ),
      ),
    )
    expect((await getWalletBalances(db, concPlayerId))['GEMS']).toBe(start + 12n)
    await reconcileLedger(concPlayerId)
  })
})

// ── 5. OVERFLOW — credits clamp exactly at the configured cap ────────────────

describe('overflow safety (cap clamping)', () => {
  it('clamps credits exactly at the cap and keeps the ledger reconciled', async () => {
    const cap = RESOURCE_CAPS['GOLD']
    const start = (await getWalletBalances(db, overPlayerId))['GOLD']
    expect(start).toBeLessThan(cap)

    // Step 1: an in-range grant lands normally.
    const first = await runEconomyTransaction(overPlayerId, (tx) =>
      grantResources(tx, overPlayerId, { GOLD: 4_000_000_000n }, { reason: 'BATTLE_REWARD' }),
    )
    const firstEntry = first.applied.find((e) => e.resource === 'GOLD')!
    expect(firstEntry.capped).toBeFalse()
    expect(firstEntry.balanceAfter).toBe(start + 4_000_000_000n)

    // Step 2: an overshooting grant clamps to the exact cap.
    const second = await runEconomyTransaction(overPlayerId, (tx) =>
      grantResources(tx, overPlayerId, { GOLD: 4_000_000_000n }, { reason: 'BATTLE_REWARD' }),
    )
    const secondEntry = second.applied.find((e) => e.resource === 'GOLD')!
    expect(secondEntry.capped).toBeTrue()
    expect(secondEntry.balanceAfter).toBe(cap)
    expect(secondEntry.balanceAfter).toBeLessThanOrEqual(cap)
    expect(secondEntry.appliedDelta).toBe(cap - (start + 4_000_000_000n))

    // Step 3: at cap, further credits apply zero (no write, no ledger row).
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: overPlayerId } })
    const third = await runEconomyTransaction(overPlayerId, (tx) =>
      grantResources(tx, overPlayerId, { GOLD: 1_000_000_000n }, { reason: 'QUEST_REWARD' }),
    )
    const thirdEntry = third.applied.find((e) => e.resource === 'GOLD')!
    expect(thirdEntry.skipped).toBeTrue()
    expect(thirdEntry.appliedDelta).toBe(0n)
    expect(await db.resourceTransaction.count({ where: { playerId: overPlayerId } })).toBe(
      ledgerBefore,
    )
    expect((await getWalletBalances(db, overPlayerId))['GOLD']).toBe(cap)

    await reconcileLedger(overPlayerId) // Σdelta == cap, exactly
  })
})

// ── 6. UNAUTHORIZED UPDATE — no client write surface, strict isolation ──────

describe('unauthorized update protection', () => {
  it('exposes a GET-only economy surface (no client write path exists)', () => {
    expect(Object.keys(resourcesRouteModule).sort()).toEqual(['GET'])
    expect(Object.keys(transactionsRouteModule).sort()).toEqual(['GET'])
  })

  it('rejects resource reads without credentials or with a garbage token', async () => {
    const anon = await resourcesGet(
      new Request('http://localhost:3000/api/v1/player/resources', {
        headers: { 'x-forwarded-for': nextIp() },
      }),
    )
    expect(anon.status).toBe(401)
    const anonBody = await parse(anon)
    expect(anonBody.ok).toBeFalse()

    const garbage = await resourcesGet(
      new Request('http://localhost:3000/api/v1/player/resources', {
        headers: { authorization: 'Bearer not-a-jwt', 'x-forwarded-for': nextIp() },
      }),
    )
    expect(garbage.status).toBe(401)

    const historyAnon = await transactionsGet(
      new Request('http://localhost:3000/api/v1/player/transactions', {
        headers: { 'x-forwarded-for': nextIp() },
      }),
    )
    expect(historyAnon.status).toBe(401)
  })

  it('scopes every read strictly to the authenticated player (no cross-player leakage)', async () => {
    // Give B its own economic activity so the two ledgers differ.
    await runEconomyTransaction(isoBPlayerId, (tx) =>
      grantResources(tx, isoBPlayerId, { GOLD: 777n }, { reason: 'BATTLE_REWARD' }),
    )

    const res = await resourcesGet(authedGet('/api/v1/player/resources', isoAToken))
    const body = await parse<WalletViewData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.playerId).toBe(isoAPlayerId)
    expect(body.data.playerId).not.toBe(isoBPlayerId)

    const history = await getTransactionHistory(db, isoAPlayerId, { limit: 100 })
    for (const entry of history.entries) {
      const stored = await db.resourceTransaction.findFirst({
        where: { id: entry.id, playerId: isoAPlayerId },
      })
      expect(stored).not.toBeNull() // every returned row is A's own ledger row
    }

    const countA = await db.resourceTransaction.count({ where: { playerId: isoAPlayerId } })
    expect(history.entries.length).toBe(countA)
  })

  it('rejects economy operations for unknown players with PLAYER_NOT_FOUND', async () => {
    await expectAppError(
      () =>
        runEconomyTransaction('nonexistent-player-id', (tx) =>
          grantResources(tx, 'nonexistent-player-id', { GOLD: 5n }, { reason: 'QUEST_REWARD' }),
        ),
      'PLAYER_NOT_FOUND',
    )
    await expectAppError(() => getWalletView(db, 'nonexistent-player-id'), 'PLAYER_NOT_FOUND')
  })
})

// ── 7. TRANSACTION ROLLBACK — all-or-nothing, zero residue ───────────────────

describe('transaction rollback (atomicity)', () => {
  it('rolls back an entire mixed batch when one resource fails validation-by-balance', async () => {
    const before = await getWalletBalances(db, rollPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })

    // +500 GOLD is fine, but the IRON debit is impossible → the WHOLE batch aborts.
    await expectAppError(
      () =>
        runEconomyTransaction(rollPlayerId, (tx) =>
          applyResourceDeltas(
            tx,
            rollPlayerId,
            [
              { resource: 'GOLD', delta: 500n },
              { resource: 'IRON', delta: -999_999_999n },
            ],
            { reason: 'ADMIN_ADJUSTMENT' },
          ),
        ),
      'INSUFFICIENT_IRON',
    )

    const after = await getWalletBalances(db, rollPlayerId)
    expect(after).toEqual(before) // the GOLD credit never landed
    expect(await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })).toBe(
      ledgerBefore,
    )
    await reconcileLedger(rollPlayerId)
  })

  it('a crash AFTER a successful grant leaves zero residue (ledger + idempotency)', async () => {
    const before = await getWalletBalances(db, rollPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })
    const key = `econ-test-crash-${rollTgId}`

    await expectAppError(
      () =>
        db.$transaction(async (tx) => {
          await grantResources(
            tx,
            rollPlayerId,
            { GOLD: 250n },
            {
              reason: 'QUEST_REWARD',
              idempotencyKey: key,
            },
          )
          throw new AppError('VALIDATION_ERROR', 'simulated crash after grant')
        }),
      'VALIDATION_ERROR',
    )

    expect(await getWalletBalances(db, rollPlayerId)).toEqual(before)
    expect(await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })).toBe(
      ledgerBefore,
    )
    // The idempotency key rolled back with the payout — a retry starts fresh.
    expect(await db.idempotencyKey.findUnique({ where: { key } })).toBeNull()

    const retry = await runEconomyTransaction(rollPlayerId, (tx) =>
      grantResources(
        tx,
        rollPlayerId,
        { GOLD: 250n },
        { reason: 'QUEST_REWARD', idempotencyKey: key },
      ),
    )
    expect(retry.replayed).toBeFalse()
    expect((await getWalletBalances(db, rollPlayerId))['GOLD']).toBe(before['GOLD'] + 250n)
    await reconcileLedger(rollPlayerId)
  })
})

// ── ADMIN_ADJUSTMENT — audited operational path ──────────────────────────────

describe('admin adjustment (audited)', () => {
  it('applies signed deltas, records ledger metadata and writes an audit row', async () => {
    const before = await getWalletBalances(db, walletPlayerId)

    const result = await adminAdjustResources({
      playerId: walletPlayerId,
      actorUserId: adminUserId,
      note: 'econ integration test adjustment',
      adjustments: { GOLD: 250n, WOOD: -50n },
    })

    const after = await getWalletBalances(db, walletPlayerId)
    expect(after['GOLD']).toBe(before['GOLD'] + 250n)
    expect(after['WOOD']).toBe(before['WOOD'] - 50n)
    expect(result.balances['GOLD']).toBe(after['GOLD'].toString())

    const adjustmentRows = await db.resourceTransaction.findMany({
      where: { playerId: walletPlayerId, reason: 'ADMIN_ADJUSTMENT' },
    })
    expect(adjustmentRows.length).toBe(2)
    for (const row of adjustmentRows) {
      expect((row.metadata as { actorUserId?: string })['actorUserId']).toBe(adminUserId)
    }

    const auditRow = await db.auditLog.findFirst({
      where: { actorUserId: adminUserId, action: 'ADJUST_RESOURCES', targetId: walletPlayerId },
    })
    expect(auditRow).not.toBeNull()
    expect(auditRow?.reason).toBe('econ integration test adjustment')

    await reconcileLedger(walletPlayerId)
  })

  it('enforces no-negative and requires a note / actor', async () => {
    const before = await getWalletBalances(db, walletPlayerId)
    await expectAppError(
      () =>
        adminAdjustResources({
          playerId: walletPlayerId,
          actorUserId: adminUserId,
          note: 'overdraft attempt',
          adjustments: { IRON: -(before['IRON'] + 1n) },
        }),
      'INSUFFICIENT_IRON',
    )
    expect((await getWalletBalances(db, walletPlayerId))['IRON']).toBe(before['IRON'])

    await expectAppError(
      () =>
        adminAdjustResources({
          playerId: walletPlayerId,
          actorUserId: adminUserId,
          note: '   ',
          adjustments: { GOLD: 1n },
        }),
      'VALIDATION_ERROR',
    )
  })
})

// ── 8. Ledger history (read API + keyset pagination) ─────────────────────────

describe('GET /api/v1/player/transactions (history API)', () => {
  it('returns the ledger newest-first with reasons, signed deltas and balances', async () => {
    const res = await transactionsGet(
      authedGet('/api/v1/player/transactions?limit=100', walletToken),
    )
    expect(res.status).toBe(200)
    const body = await parse<LedgerPageData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.hasMore).toBeFalse()
    expect(body.data.nextCursor).toBeNull()

    const reasons = new Set(body.data.entries.map((e) => e.reason))
    expect(reasons.has('BOOTSTRAP')).toBeTrue() // faucet rows
    expect(reasons.has('ADMIN_ADJUSTMENT')).toBeTrue() // from the audit test above

    const dbCount = await db.resourceTransaction.count({ where: { playerId: walletPlayerId } })
    expect(body.data.entries.length).toBe(dbCount)

    // Newest first: createdAt is non-increasing.
    for (let i = 1; i < body.data.entries.length; i++) {
      expect(body.data.entries[i - 1]!.createdAt >= body.data.entries[i]!.createdAt).toBeTrue()
    }
    // BigInt policy: amounts cross the API as strings.
    for (const entry of body.data.entries) {
      expect(typeof entry.delta).toBe('string')
      expect(typeof entry.balanceAfter).toBe('string')
    }
  })

  it('paginates with the keyset cursor without skipping or repeating rows', async () => {
    const collected: string[] = []
    let cursor: string | null = null

    for (let page = 0; page < 10; page++) {
      const url = `/api/v1/player/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await transactionsGet(authedGet(url, walletToken))
      const body = await parse<LedgerPageData>(res)
      expect(body.ok).toBe(true)
      if (!body.ok) return
      collected.push(...body.data.entries.map((e) => e.id))
      if (!body.data.hasMore) {
        expect(body.data.nextCursor).toBeNull()
        break
      }
      expect(body.data.nextCursor).not.toBeNull()
      cursor = body.data.nextCursor
    }

    const dbCount = await db.resourceTransaction.count({ where: { playerId: walletPlayerId } })
    expect(new Set(collected).size).toBe(collected.length) // no repeats
    expect(collected.length).toBe(dbCount) // no skips
  })

  it('filters by ledger reason', async () => {
    const res = await transactionsGet(
      authedGet('/api/v1/player/transactions?reason=BOOTSTRAP', walletToken),
    )
    const body = await parse<LedgerPageData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.entries.length).toBe(5) // the five starter-wallet faucet rows
    for (const entry of body.data.entries) {
      expect(entry.reason).toBe('BOOTSTRAP')
      expect(entry.delta).toBe(entry.balanceAfter) // first rows of each chain
    }
  })

  it('rejects invalid query parameters', async () => {
    const badReason = await transactionsGet(
      authedGet('/api/v1/player/transactions?reason=FREE_COINS', walletToken),
    )
    expect(badReason.status).toBe(400)
    const badBody = await parse(badReason)
    expect(badBody.ok).toBeFalse()
    if (!badBody.ok) expect(badBody.error.code).toBe('VALIDATION_ERROR')

    const badLimit = await transactionsGet(
      authedGet('/api/v1/player/transactions?limit=0', walletToken),
    )
    expect(badLimit.status).toBe(400)
  })
})
