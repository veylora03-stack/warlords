/**
 * Concurrency escalation probe (Phase 25 diagnostic): times train+cancel
 * cycles at increasing concurrency levels to locate the stall knee.
 */
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const BASE = 'http://localhost:3000'

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({ id: Number(telegramId), first_name: `Esc${telegramId.slice(-3)}` }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN!).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

async function register(telegramId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.128.1' },
    body: JSON.stringify({ initData: buildInitData(telegramId) }),
  })
  const body = (await res.json()) as { data: { token: string } }
  return body.data.token
}

async function trainCancel(token: string, ip: string): Promise<number> {
  const t0 = performance.now()
  const train = await fetch(`${BASE}/api/v1/army/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify({ unitId: 'swordsman', count: 1 }),
  }).then((r) => r.json() as Promise<{ data: { item: { id: string } } }>)
  const itemId = train.data?.item?.id
  if (!itemId) return performance.now() - t0
  await fetch(`${BASE}/api/v1/army/train/${itemId}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
  })
  return performance.now() - t0
}

async function main(): Promise<void> {
  await db.user.deleteMany({ where: { telegramId: { startsWith: '9100028' } } })
  const tokens: string[] = []
  for (let i = 1; i <= 8; i++) {
    tokens.push(await register(`9100028000${i}`))
  }
  const ips = tokens.map((_, i) => `203.0.128.${i + 1}`)

  for (const concurrency of [1, 2, 4, 8]) {
    const batch = tokens.slice(0, concurrency).map((t, i) => trainCancel(t, ips[i]!))
    const t0 = performance.now()
    const results = await Promise.all(batch)
    const wall = performance.now() - t0
    const sorted = results.slice().sort((a, b) => a - b)
    console.log(
      `concurrency=${concurrency}: per-op min=${sorted[0]!.toFixed(0)}ms median=${sorted[Math.floor(concurrency / 2)]!.toFixed(0)}ms max=${sorted[concurrency - 1]!.toFixed(0)}ms wall=${wall.toFixed(0)}ms`,
    )
    await new Promise((r) => setTimeout(r, 500))
  }
  await db.user.deleteMany({ where: { telegramId: { startsWith: '9100028' } } })
  await db.$disconnect()
  process.exit(0)
}

await main()
