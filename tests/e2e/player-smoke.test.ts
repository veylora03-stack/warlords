/**
 * E2E player smoke tests — run against a REAL running server.
 *
 * Prerequisite: dev or production server on :3000 (or E2E_BASE_URL) with
 * TELEGRAM_BOT_TOKEN configured. The 401 paths always run (they need no
 * secrets); the positive flow runs only when the token is present so the
 * suite stays honest in any environment — a skip is reported, never faked.
 */

import { describe, it, expect, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { ApiEnvelope } from '../../src/types/api'

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const TEST_TG_ID = '9100004001'

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
    query_id: `AAE2P00000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 30),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'E2EPlayer',
      username: 'e2e_player',
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

interface ProfileData {
  id: string
  level: number
  xp: string
  power: string
  energy: number
  energyMax: number
  reputation: string
  city: { x: number; y: number } | null
}

interface StateData {
  profile: ProfileData
  wallet: Record<string, string>
  army: Array<{ unitId: string; count: number }>
  buildingCount: number
}

describe.skipIf(!serverReachable)('GET /api/v1/player/* — live guard contract', () => {
  it('anonymous /player/profile → 401 envelope', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/player/profile`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('anonymous /player/state → 401 envelope', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/player/state`)
    expect(res.status).toBe(401)
  })

  it('full live flow: exchange → profile → state → statistics', async () => {
    if (!BOT_TOKEN) {
      console.warn(
        '[e2e] TELEGRAM_BOT_TOKEN not set — skipping positive flows (reported, not faked)',
      )
      return
    }

    const exchange = await fetch(`${BASE_URL}/api/v1/auth/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: buildInitData(TEST_TG_ID) }),
    })
    expect(exchange.status).toBe(200)
    const body = (await exchange.json()) as ApiEnvelope<{ token: string }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    const auth = { authorization: `Bearer ${body.data.token}` }

    const profile = await fetch(`${BASE_URL}/api/v1/player/profile`, { headers: auth })
    expect(profile.status).toBe(200)
    const profileBody = (await profile.json()) as ApiEnvelope<ProfileData>
    expect(profileBody.ok).toBe(true)
    if (profileBody.ok) {
      expect(profileBody.data.level).toBe(1)
      expect(profileBody.data.xp).toBe('0')
      expect(typeof profileBody.data.power).toBe('string')
      expect(Number(profileBody.data.power)).toBeGreaterThan(0)
      expect(profileBody.data.energyMax).toBe(100)
      expect(profileBody.data.city).not.toBeNull()
    }

    const state = await fetch(`${BASE_URL}/api/v1/player/state`, { headers: auth })
    expect(state.status).toBe(200)
    const stateBody = (await state.json()) as ApiEnvelope<StateData>
    expect(stateBody.ok).toBe(true)
    if (stateBody.ok) {
      // Initial resources arrive as opaque display strings (BigInt policy).
      for (const amount of Object.values(stateBody.data.wallet)) {
        expect(amount).toMatch(/^\d+$/)
      }
      expect(stateBody.data.buildingCount).toBe(17)
      expect(stateBody.data.army.length).toBeGreaterThan(0)
    }

    const statistics = await fetch(`${BASE_URL}/api/v1/player/statistics`, { headers: auth })
    expect(statistics.status).toBe(200)
    const statisticsBody = (await statistics.json()) as ApiEnvelope<{
      statistics: Record<string, number>
    }>
    expect(statisticsBody.ok).toBe(true)
    if (statisticsBody.ok) {
      expect(Object.keys(statisticsBody.data.statistics).length).toBeGreaterThan(0)
    }
  })

  afterAll(async () => {
    if (!serverReachable) return
    const { db } = await import('../../src/lib/db')
    // Per-row delete: bulk deleteMany can transiently violate FK ordering
    // under the SQLite foreign-key emulation (same artifact as auth-flow).
    const users = await db.user.findMany({
      where: { telegramId: { startsWith: '9100004' } },
      select: { id: true },
    })
    for (const user of users) {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
    }
    await db.$disconnect()
  })
})
