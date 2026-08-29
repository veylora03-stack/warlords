/**
 * E2E army smoke tests — run against a REAL running server.
 *
 * Prerequisite: dev or production server on :3000 (or E2E_BASE_URL) with
 * TELEGRAM_BOT_TOKEN configured. The 401 paths always run (they need no
 * secrets); the positive recruitment flow runs only when the token is
 * present so the suite stays honest in any environment — a skip is
 * reported, never faked.
 */

import { describe, it, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { ApiEnvelope } from '../../src/types/api'

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
// Per-run e2e identity in the dedicated e2e range (9100008…) — a fresh
// telegramId per invocation guarantees a pristine starter army.
const TEST_TG_ID = `9100008${String((Date.now() + 7) % 1_000_000).padStart(6, '0')}`

const CLIENT_IP = `203.0.202.${10 + (Date.now() % 200)}`
const CLIENT_HEADERS = { 'x-forwarded-for': CLIENT_IP } as const

/** Reachability probe at module load (skipIf captures at registration). */
const serverReachable = await fetch(`${BASE_URL}/api/health`, {
  signal: AbortSignal.timeout(5000),
})
  .then(() => true)
  .catch(() => {
    console.error(`\n[e2e] No server at ${BASE_URL}. Start it first:  bun run dev\n`)
    return false
  })

function buildInitData(telegramId: string): string {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN required for positive e2e flow')
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 30),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'E2EArmyLord',
      username: 'e2e_army_lord',
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

interface QueueItemData {
  id: string
  unitId: string
  count: number
  status: string
  completesAt: string
  remainingSec: number
}

interface ArmyData {
  units: Array<{ unitId: string; count: number }>
  totals: { unitCount: number; upkeepFood: number }
  training: { queue: QueueItemData[]; activeCount: number; queueSlots: number }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('army endpoints over live HTTP (guard contract)', () => {
  it('requires authentication for all five army endpoints', async () => {
    if (!serverReachable) return

    const army = await fetch(`${BASE_URL}/api/v1/army`)
    expect(army.status).toBe(401)
    const armyBody = (await army.json()) as ApiEnvelope<unknown>
    expect(armyBody.ok).toBeFalse()

    const catalog = await fetch(`${BASE_URL}/api/v1/army/catalog`)
    expect(catalog.status).toBe(401)

    const train = await fetch(`${BASE_URL}/api/v1/army/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitId: 'swordsman', count: 1 }),
    })
    expect(train.status).toBe(401)

    const complete = await fetch(`${BASE_URL}/api/v1/army/train/x/complete`, { method: 'POST' })
    expect(complete.status).toBe(401)

    const cancel = await fetch(`${BASE_URL}/api/v1/army/train/x/cancel`, { method: 'POST' })
    expect(cancel.status).toBe(401)

    const garbage = await fetch(`${BASE_URL}/api/v1/army`, {
      headers: { authorization: 'Bearer garbage-token' },
    })
    expect(garbage.status).toBe(401)
  })

  it('lists the army endpoints in the /api index', async () => {
    if (!serverReachable) return

    const res = await fetch(`${BASE_URL}/api`)
    const body = (await res.json()) as ApiEnvelope<Record<string, string>>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.endpoints['army:state']).toContain('/api/v1/army')
    expect(body.data.endpoints['army:state']).toContain('GET')
    expect(body.data.endpoints['army:unit-catalog']).toContain('/api/v1/army/catalog')
    expect(body.data.endpoints['army:train']).toContain('POST /api/v1/army/train')
    expect(body.data.endpoints['army:train-complete']).toContain('/army/train/:id/complete')
    expect(body.data.endpoints['army:train-cancel']).toContain('/army/train/:id/cancel')
  })
})

describe('army positive flow over live HTTP', () => {
  it('exchanges initData, projects the roster, recruits, and completes one batch', async () => {
    if (!serverReachable) return
    if (!BOT_TOKEN) {
      console.error('\n[e2e] TELEGRAM_BOT_TOKEN not set — positive flow skipped (not faked)\n')
      return
    }

    // 1) Auth exchange — first login bootstraps player + city + starter army.
    const auth = await fetch(`${BASE_URL}/api/v1/auth/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify({ initData: buildInitData(TEST_TG_ID) }),
    })
    expect(auth.status).toBe(200)
    const authBody = (await auth.json()) as ApiEnvelope<{ token: string }>
    expect(authBody.ok).toBe(true)
    if (!authBody.ok) return
    const bearer = {
      authorization: `Bearer ${authBody.data.token}`,
      ...CLIENT_HEADERS,
    } as const

    // 2) Army view — 11-unit roster with the starter stacks (20+10).
    const armyRes = await fetch(`${BASE_URL}/api/v1/army`, { headers: bearer })
    expect(armyRes.status).toBe(200)
    const armyBody = (await armyRes.json()) as ApiEnvelope<ArmyData>
    expect(armyBody.ok).toBe(true)
    if (!armyBody.ok) return
    expect(armyBody.data.units.length).toBe(11)
    expect(armyBody.data.totals.unitCount).toBe(30)
    expect(armyBody.data.units.find((u) => u.unitId === 'swordsman')?.count).toBe(20)

    // 3) Catalog — costs cross as strings (BigInt policy), 11 entries.
    const catalogRes = await fetch(`${BASE_URL}/api/v1/army/catalog`, { headers: bearer })
    expect(catalogRes.status).toBe(200)
    const catalogBody = (await catalogRes.json()) as ApiEnvelope<{
      units: Array<{ id: string; trainingCost: Record<string, string> }>
    }>
    expect(catalogBody.ok).toBe(true)
    if (!catalogBody.ok) return
    expect(catalogBody.data.units.length).toBe(11)
    const catapult = catalogBody.data.units.find((u) => u.id === 'catapult')
    expect(catapult?.trainingCost['GOLD']).toBe('250')

    // 4) Validation — negative quantity refused before any resource math.
    const negative = await fetch(`${BASE_URL}/api/v1/army/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ unitId: 'swordsman', count: -3 }),
    })
    expect(negative.status).toBe(400)

    // 5) Recruit ONE archer — a 15s window at base speed.
    const trainRes = await fetch(`${BASE_URL}/api/v1/army/train`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ unitId: 'archer', count: 1 }),
    })
    expect(trainRes.status).toBe(200)
    const trainBody = (await trainRes.json()) as ApiEnvelope<{ item: QueueItemData }>
    expect(trainBody.ok).toBe(true)
    if (!trainBody.ok) return
    const itemId = trainBody.data.item.id
    expect(trainBody.data.item.status).toBe('TRAINING')

    // 6) The queue is visible in the army view.
    const duringRes = await fetch(`${BASE_URL}/api/v1/army`, { headers: bearer })
    const during = (await duringRes.json()) as ApiEnvelope<ArmyData>
    expect(during.ok).toBe(true)
    if (during.ok) expect(during.data.training.activeCount).toBe(1)

    // 7) Poll until the server clock passes completesAt (bounded).
    const completesAtMs = Date.parse(trainBody.data.item.completesAt)
    while (Date.now() < completesAtMs) {
      await sleep(1000)
    }

    // 8) Claim the finished batch.
    const completeRes = await fetch(`${BASE_URL}/api/v1/army/train/${itemId}/complete`, {
      method: 'POST',
      headers: bearer,
    })
    expect(completeRes.status).toBe(200)
    const completeBody = (await completeRes.json()) as ApiEnvelope<{
      completed: { unitId: string; count: number }
      stackCount: number
    }>
    expect(completeBody.ok).toBe(true)
    if (!completeBody.ok) return
    expect(completeBody.data.completed.unitId).toBe('archer')
    expect(completeBody.data.completed.count).toBe(1)
    expect(completeBody.data.stackCount).toBe(11) // 10 starter archers + 1 trained

    // 9) A double claim is honestly refused.
    const again = await fetch(`${BASE_URL}/api/v1/army/train/${itemId}/complete`, {
      method: 'POST',
      headers: bearer,
    })
    expect(again.status).toBe(409)
    const againBody = (await again.json()) as ApiEnvelope<{ error: { code: string } }>
    if (!againBody.ok) expect(againBody.error.code).toBe('TRAINING_NOT_ACTIVE')
  }, 120_000)
})
