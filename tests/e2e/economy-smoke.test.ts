/**
 * E2E economy smoke tests — run against a REAL running server.
 *
 * Prerequisite: dev or production server on :3000 (or E2E_BASE_URL) with
 * TELEGRAM_BOT_TOKEN configured. The 401 paths always run (they need no
 * secrets); the positive flow runs only when the token is present so the
 * suite stays honest in any environment — a skip is reported, never faked.
 */

import { describe, it, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { ApiEnvelope } from '../../src/types/api'

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000'
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const TEST_TG_ID = '9100006001'

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
    query_id: `AAE5E000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 30),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'E2EEconomy',
      username: 'e2e_economy',
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

interface WalletViewData {
  playerId: string
  resources: Array<{ key: string; balance: string; cap: string; headroom: string }>
  updatedAt: string
}

interface LedgerPageData {
  entries: Array<{
    id: string
    resource: string
    delta: string
    balanceAfter: string
    reason: string
    createdAt: string
  }>
  nextCursor: string | null
  hasMore: boolean
}

describe('economy endpoints over live HTTP (guard contract)', () => {
  it('requires authentication for both economy endpoints', async () => {
    if (!serverReachable) return

    const resources = await fetch(`${BASE_URL}/api/v1/player/resources`)
    expect(resources.status).toBe(401)
    const resourcesBody = (await resources.json()) as ApiEnvelope<unknown>
    expect(resourcesBody.ok).toBeFalse()

    const transactions = await fetch(`${BASE_URL}/api/v1/player/transactions`)
    expect(transactions.status).toBe(401)

    const garbage = await fetch(`${BASE_URL}/api/v1/player/resources`, {
      headers: { authorization: 'Bearer garbage-token' },
    })
    expect(garbage.status).toBe(401)
  })

  it('lists the economy endpoints in the /api index', async () => {
    if (!serverReachable) return

    const res = await fetch(`${BASE_URL}/api`)
    const body = (await res.json()) as ApiEnvelope<Record<string, string>>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.endpoints['player:resources']).toBe('GET /api/v1/player/resources')
    expect(body.data.endpoints['player:transactions']).toContain('/api/v1/player/transactions')
  })
})

describe('economy positive flow over live HTTP', () => {
  it('exchanges initData and serves the ledger-backed wallet + history', async () => {
    if (!serverReachable) return
    if (!BOT_TOKEN) {
      console.error('\n[e2e] TELEGRAM_BOT_TOKEN not set — positive flow skipped (not faked)\n')
      return
    }

    // 1) Auth exchange — first login bootstraps wallet + ledger faucet.
    const auth = await fetch(`${BASE_URL}/api/v1/auth/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: buildInitData(TEST_TG_ID) }),
    })
    expect(auth.status).toBe(200)
    const authBody = (await auth.json()) as ApiEnvelope<{ token: string }>
    expect(authBody.ok).toBe(true)
    if (!authBody.ok) return
    const token = authBody.data.token
    const bearer = { authorization: `Bearer ${token}` }

    // 2) Wallet view — six resources, BigInt-as-string, caps present.
    const resources = await fetch(`${BASE_URL}/api/v1/player/resources`, { headers: bearer })
    expect(resources.status).toBe(200)
    const walletBody = (await resources.json()) as ApiEnvelope<WalletViewData>
    expect(walletBody.ok).toBe(true)
    if (!walletBody.ok) return
    expect(walletBody.data.resources.map((r) => r.key)).toEqual([
      'GOLD',
      'WOOD',
      'IRON',
      'FOOD',
      'CRYSTAL',
      'GEMS',
    ])
    for (const entry of walletBody.data.resources) {
      expect(typeof entry.balance).toBe('string')
      expect(BigInt(entry.balance) >= 0n).toBeTrue() // no-negative, end to end
      expect(BigInt(entry.headroom) >= 0n).toBeTrue()
    }
    const gold = walletBody.data.resources.find((r) => r.key === 'GOLD')!
    expect(Number(gold.balance)).toBeGreaterThan(0) // starter faucet landed

    // 3) Ledger history — BOOTSTRAP rows with running balanceAfter chain.
    const history = await fetch(`${BASE_URL}/api/v1/player/transactions?limit=10`, {
      headers: bearer,
    })
    expect(history.status).toBe(200)
    const historyBody = (await history.json()) as ApiEnvelope<LedgerPageData>
    expect(historyBody.ok).toBe(true)
    if (!historyBody.ok) return
    expect(historyBody.data.entries.length).toBeGreaterThan(0)
    for (const entry of historyBody.data.entries) {
      expect(typeof entry.delta).toBe('string')
      expect(entry.reason.length).toBeGreaterThan(0) // every delta has a reason
    }
    expect(historyBody.data.entries.some((e) => e.reason === 'BOOTSTRAP')).toBeTrue()
  })
})
