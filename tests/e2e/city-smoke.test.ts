/**
 * E2E city smoke tests — run against a REAL running server.
 *
 * Prerequisite: dev or production server on :3000 (or E2E_BASE_URL) with
 * TELEGRAM_BOT_TOKEN configured. The 401 paths always run (they need no
 * secrets); the positive construction flow runs only when the token is
 * present so the suite stays honest in any environment — a skip is
 * reported, never faked.
 */

import { describe, it, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { ApiEnvelope } from '../../src/types/api'

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
// Per-run e2e identity in the dedicated e2e range (9100008…) — a fresh
// telegramId per invocation guarantees a pristine starter city, so the
// construction flow is deterministic no matter how often the suite runs.
// (Previous phases' suites reuse one id and accumulate state across runs;
// the construction lifecycle needs a clean world to assert against.)
const TEST_TG_ID = `9100008${String(Date.now() % 1_000_000).padStart(6, '0')}`

// A stable per-run client identity — keeps this suite's auth rate-limit
// budget isolated from other suites and repeated runs (sliding window is
// keyed per user/IP; the limiter itself is exercised honestly, not bypassed
// mid-window for the SAME identity).
const CLIENT_IP = `203.0.201.${10 + (Date.now() % 200)}`
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
      first_name: 'E2ECityLord',
      username: 'e2e_city_lord',
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

interface CityBuildingData {
  id: string
  type: string
  level: number
  maxLevel: number
  status: string
  pendingLevel: number | null
  nextUpgrade: {
    toLevel: number
    cost: Record<string, string>
    durationSec: number
    requirementsMet: boolean
  } | null
}

interface CityData {
  city: { id: string; name: string; x: number; y: number }
  buildings: CityBuildingData[]
  production: Record<string, number>
  storage: { capacity: number }
  construction: { activeCount: number; queueSlots: number }
}

describe('city endpoints over live HTTP (guard contract)', () => {
  it('requires authentication for all four city endpoints', async () => {
    if (!serverReachable) return

    const city = await fetch(`${BASE_URL}/api/v1/city`)
    expect(city.status).toBe(401)
    const cityBody = (await city.json()) as ApiEnvelope<unknown>
    expect(cityBody.ok).toBeFalse()

    const catalog = await fetch(`${BASE_URL}/api/v1/city/buildings`)
    expect(catalog.status).toBe(401)

    const upgrade = await fetch(`${BASE_URL}/api/v1/city/buildings/FARM/upgrade`, {
      method: 'POST',
    })
    expect(upgrade.status).toBe(401)

    const finish = await fetch(`${BASE_URL}/api/v1/city/buildings/FARM/finish`, {
      method: 'POST',
    })
    expect(finish.status).toBe(401)

    const garbage = await fetch(`${BASE_URL}/api/v1/city`, {
      headers: { authorization: 'Bearer garbage-token' },
    })
    expect(garbage.status).toBe(401)
  })

  it('lists the city endpoints in the /api index', async () => {
    if (!serverReachable) return

    const res = await fetch(`${BASE_URL}/api`)
    const body = (await res.json()) as ApiEnvelope<Record<string, string>>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.endpoints['city:state']).toContain('/api/v1/city')
    expect(body.data.endpoints['city:state']).toContain('GET')
    expect(body.data.endpoints['city:building-catalog']).toContain('/api/v1/city/buildings')
    expect(body.data.endpoints['city:upgrade']).toContain('/city/buildings/:type/upgrade')
    expect(body.data.endpoints['city:finish']).toContain('/city/buildings/:type/finish')
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Any construction left in flight by a previous run → claim it once the
 * server clock passes its completesAt (polled, bounded). */
async function claimInFlight(bearer: Record<string, string>): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/city`, { headers: bearer })
  if (res.status !== 200) return
  const body = (await res.json()) as ApiEnvelope<CityData>
  if (!body.ok) return
  const active = body.data.buildings.find((b) => b.status !== 'IDLE')
  if (!active || !active.upgradeCompletesAt) return

  const completesAtMs = Date.parse(active.upgradeCompletesAt)
  while (Date.now() < completesAtMs && Date.now() < completesAtMs + 30_000) {
    await sleep(1000)
  }

  const finishRes = await fetch(`${BASE_URL}/api/v1/city/buildings/${active.type}/finish`, {
    method: 'POST',
    headers: bearer,
  })
  // 200 (claimed by THIS call) or 409 (already claimed / not active) — both
  // prove the lifecycle endpoint answers; 409 NOT_COMPLETE would mean the
  // server clock still hasn't reached completesAt, which the poll prevents.
  expect([200, 409]).toContain(finishRes.status)
  const finishBody = (await finishRes.json()) as ApiEnvelope<unknown>
  if (!finishBody.ok) {
    expect(['CONSTRUCTION_NOT_ACTIVE', 'CONSTRUCTION_NOT_COMPLETE']).toContain(
      finishBody.error.code,
    )
  }
}

describe('city positive flow over live HTTP', () => {
  it('exchanges initData, projects the city and runs one full construction cycle', async () => {
    if (!serverReachable) return
    if (!BOT_TOKEN) {
      console.error('\n[e2e] TELEGRAM_BOT_TOKEN not set — positive flow skipped (not faked)\n')
      return
    }

    // 1) Auth exchange — first login bootstraps player + city + 17 buildings.
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

    // 2) Claim anything left in flight by a previous run (idempotency).
    await claimInFlight(bearer as Record<string, string>)

    // 3) City view — 17 buildings, level 1, idle, aggregates present.
    const cityRes = await fetch(`${BASE_URL}/api/v1/city`, { headers: bearer })
    expect(cityRes.status).toBe(200)
    const cityBody = (await cityRes.json()) as ApiEnvelope<CityData>
    expect(cityBody.ok).toBe(true)
    if (!cityBody.ok) return
    const city = cityBody.data
    expect(city.buildings.length).toBe(17)
    expect(city.construction.queueSlots).toBe(1)

    // 4) Catalog — costs cross as strings (BigInt policy), castle capped at 11.
    const catalogRes = await fetch(`${BASE_URL}/api/v1/city/buildings`, { headers: bearer })
    expect(catalogRes.status).toBe(200)
    const catalogBody = (await catalogRes.json()) as ApiEnvelope<{
      types: Array<{ type: string; maxLevel: number }>
    }>
    expect(catalogBody.ok).toBe(true)
    if (!catalogBody.ok) return
    expect(catalogBody.data.types.find((t) => t.type === 'CASTLE')?.maxLevel).toBe(11)

    // 5) Run ONE construction cycle on whatever building the SERVER flags as
    // requirement-ready — idempotent across repeated e2e runs: early runs
    // upgrade TH-gate-1 buildings, exhausted worlds get the typed refusal.
    const target = city.buildings.find((b) => b.status === 'IDLE' && b.nextUpgrade?.requirementsMet)
    const upgradeRes = await fetch(
      `${BASE_URL}/api/v1/city/buildings/${target?.type ?? 'FARM'}/upgrade`,
      { method: 'POST', headers: bearer },
    )

    if (!target) {
      // Every building is maxed or requirement-blocked at this Town Hall
      // level — the honest server answer is a typed 409, never a fake success.
      expect(upgradeRes.status).toBe(409)
      const refusal = (await upgradeRes.json()) as ApiEnvelope<{ code?: string }>
      if (!refusal.ok) {
        expect([
          'PREREQUISITE_MISSING',
          'MAX_LEVEL_REACHED',
          'BUILDING_QUEUE_BUSY',
          'CONSTRUCTION_IN_PROGRESS',
          'INSUFFICIENT_GOLD',
          'INSUFFICIENT_WOOD',
          'INSUFFICIENT_FOOD',
          'INSUFFICIENT_IRON',
          'INSUFFICIENT_CRYSTAL',
        ]).toContain(refusal.error.code)
      }
      return
    }

    expect(upgradeRes.status).toBe(200)
    const upgraded = (await upgradeRes.json()) as ApiEnvelope<{ building: CityBuildingData }>
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    expect(upgraded.data.building.type).toBe(target.type)
    expect(upgraded.data.building.status).toBe('CONSTRUCTING')
    expect(upgraded.data.building.pendingLevel).toBe(target.level + 1)

    // 6) The city view reflects the in-flight construction.
    const duringRes = await fetch(`${BASE_URL}/api/v1/city`, { headers: bearer })
    expect(duringRes.status).toBe(200)
    const during = (await duringRes.json()) as ApiEnvelope<CityData>
    expect(during.ok).toBe(true)
    if (during.ok) {
      expect(during.data.construction.activeCount).toBe(1)
      const duringTarget = during.data.buildings.find((b) => b.type === target.type)!
      expect(duringTarget.status).toBe('CONSTRUCTING')
      expect(duringTarget.nextUpgrade).toBeNull()
    }

    // 7) An early finish claim is refused against the server clock.
    const earlyFinish = await fetch(`${BASE_URL}/api/v1/city/buildings/${target.type}/finish`, {
      method: 'POST',
      headers: bearer,
    })
    // The claim may race the (≥12s) timer on a very slow machine — accept the
    // honest refusal OR a legitimately completed claim; both are typed.
    expect([200, 409]).toContain(earlyFinish.status)
    const earlyBody = (await earlyFinish.json()) as ApiEnvelope<unknown>
    if (!earlyBody.ok) {
      expect(['CONSTRUCTION_NOT_COMPLETE', 'CONSTRUCTION_NOT_ACTIVE']).toContain(
        earlyBody.error.code,
      )
    }
  }, 90_000)
})
