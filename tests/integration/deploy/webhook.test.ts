/**
 * Integration tests — deployment health probes & Telegram webhook pipeline
 * (Phase 26).
 *
 * Route handlers are invoked directly with constructed Request objects —
 * the real probe services and the real webhook pipeline run against the
 * real dev database (zero mocks; the Telegram TRANSPORT is injected so the
 * network is never touched, mirroring the existing send-message DI rule).
 *
 * Covered:
 *  1. GET /health  — liveness: 200, dependency-free shape
 *  2. GET /ready   — readiness: 200 ready, real DB round-trip reported up
 *  3. webhook auth — 503 unconfigured · 401 missing/mismatched secret
 *  4. webhook robustness — oversized / non-JSON / malformed updates acked 200
 *  5. webhook command flow — real router + REAL DB loaders; transport
 *     captured (never network); retryable send → 503, permanent → 200
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { GET as healthGet } from '../../../src/app/health/route'
import { GET as readyGet } from '../../../src/app/ready/route'
import {
  handleWebhookRequest,
  loadPlayerSnapshotByTelegramId,
  loadRankingSnapshot,
  verifyWebhookSecret,
  TELEGRAM_WEBHOOK_HEADER,
  type WebhookDeps,
} from '../../../src/lib/telegram/webhook.service'
import { createBotRouter } from '../../../src/lib/telegram/bot'
import { TelegramDeliveryError } from '../../../src/lib/telegram/send-message'
import { db } from '../../../src/lib/db'
import { APP_VERSION } from '../../../src/config/app'

const SECRET = 'test-webhook-secret-91000266'
const TOKEN = '123456:TEST-TOKEN-NOT-REAL'
const TG_RANGE = '9100026'

interface SentMessage {
  chatId: string
  text: string
  replyMarkup?: Record<string, unknown>
}

function makeDeps(overrides: Partial<WebhookDeps> = {}, sent: SentMessage[] = []): WebhookDeps {
  return {
    botToken: TOKEN,
    webhookSecret: SECRET,
    router: createBotRouter({
      appUrl: 'https://warlords.example.com',
      getSnapshotByTelegramId: loadPlayerSnapshotByTelegramId,
      getRankingSnapshot: loadRankingSnapshot,
    }),
    sendMessage: async (input) => {
      sent.push({ chatId: input.chatId, text: input.text, replyMarkup: input.replyMarkup })
    },
    ...overrides,
  }
}

function webhookRequest(body: string | unknown, secret: string | null = SECRET): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (secret !== null) headers.set(TELEGRAM_WEBHOOK_HEADER, secret)
  return new Request('https://warlords.example.com/api/v1/telegram/webhook', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function startUpdate(text: string, telegramId = 910002661, firstName = 'Deploy'): unknown {
  return {
    update_id: 42,
    message: { message_id: 1, from: { id: telegramId, first_name: firstName }, text },
  }
}

const sent: SentMessage[] = []

describe('GET /health — liveness', () => {
  it('returns 200 with a dependency-free probe report', async () => {
    const response = await healthGet()
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['app']).toBe('warlords')
    expect(body['version']).toBe(APP_VERSION)
    expect(Number(body['uptimeSec'])).toBeGreaterThanOrEqual(0)
    expect(body['timestamp']).toBeString()
    // liveness must NOT carry db fields — that is /ready's job
    expect(body['db']).toBeUndefined()
  })
})

describe('GET /ready — readiness', () => {
  it('reports ready with a real database round-trip', async () => {
    const response = await readyGet()
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      checks: {
        db: { status: string; latencyMs: number | null }
        config: { status: string }
        worker: { status: string }
      }
    }
    expect(body.status).toBe('ready')
    expect(body.checks.db.status).toBe('up')
    expect(body.checks.db.latencyMs).not.toBeNull()
    // non-production run: config check skipped, worker informational
    expect(body.checks.config.status).toBe('skipped')
    expect(body.checks.worker.status).toBe('skipped')
  })
})

describe('webhook secret gate', () => {
  it('compares secrets in constant time (correct + wrong + missing)', () => {
    expect(verifyWebhookSecret(SECRET, SECRET)).toBe(true)
    expect(verifyWebhookSecret('wrong-secret', SECRET)).toBe(false)
    expect(verifyWebhookSecret(null, SECRET)).toBe(false)
    expect(verifyWebhookSecret('', SECRET)).toBe(false)
    expect(verifyWebhookSecret(SECRET, '')).toBe(false)
  })

  it('503s while the bot transport is unconfigured (sandbox/dev default)', async () => {
    const response = await handleWebhookRequest(
      webhookRequest(startUpdate('/start')),
      makeDeps({ botToken: null, webhookSecret: null }),
    )
    expect(response.status).toBe(503)
  })

  it('401s a missing or mismatched secret header — before any body parsing', async () => {
    const missing = await handleWebhookRequest(
      webhookRequest(startUpdate('/start'), null),
      makeDeps({}, sent),
    )
    expect(missing.status).toBe(401)

    const wrong = await handleWebhookRequest(
      webhookRequest(startUpdate('/start'), 'not-the-secret'),
      makeDeps({}, sent),
    )
    expect(wrong.status).toBe(401)
    expect(sent).toHaveLength(0)
  })
})

describe('webhook robustness (garbage never causes 5xx storms)', () => {
  it('acks oversized bodies with 200 and sends nothing', async () => {
    const response = await handleWebhookRequest(
      webhookRequest('x'.repeat(70_000)),
      makeDeps({}, sent),
    )
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  it('acks non-JSON and malformed updates with 200', async () => {
    for (const bad of ['not json at all', JSON.stringify({ foo: 1 }), JSON.stringify(null)]) {
      const response = await handleWebhookRequest(webhookRequest(bad), makeDeps({}, sent))
      expect(response.status).toBe(200)
    }
    expect(sent).toHaveLength(0)
  })

  it('ignores bot-authored and non-command messages', async () => {
    const fromBot = startUpdate('/start')
    ;(fromBot as { message: { from: { is_bot: boolean } } }).message.from.is_bot = true
    for (const update of [fromBot, startUpdate('hello there, not a command')]) {
      const response = await handleWebhookRequest(webhookRequest(update), makeDeps({}, sent))
      expect(response.status).toBe(200)
    }
    expect(sent).toHaveLength(0)
  })
})

describe('webhook command flow (real router, real DB loaders, captured transport)', () => {
  const TG = `${TG_RANGE}661`

  beforeAll(async () => {
    // self-healing isolated identity range (same policy as other suites)
    await db.user.deleteMany({ where: { telegramId: { startsWith: TG_RANGE } } })
    await db.user.create({
      data: {
        telegramId: TG,
        firstName: 'Deploy',
        player: {
          create: {
            name: 'DeployRankTester',
            wallet: { create: { gold: 5_000n, wood: 1_234n, iron: 12n, food: 56n, crystal: 7n } },
          },
        },
      },
    })
  })

  afterAll(async () => {
    await db.user.deleteMany({ where: { telegramId: { startsWith: TG_RANGE } } })
  })

  it('/start answers the sender chat with the Mini App keyboard', async () => {
    const response = await handleWebhookRequest(
      webhookRequest(startUpdate('/start', 910002662, 'Neo')),
      makeDeps({}, sent),
    )
    expect(response.status).toBe(200)
    const last = sent.at(-1)!
    expect(last.chatId).toBe('910002662')
    expect(last.text).toContain('Welcome to WARLORDS, Neo!')
    expect(last.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(
      'https://warlords.example.com',
    )
  })

  it('/profile resolves the REAL player snapshot from the database', async () => {
    const response = await handleWebhookRequest(
      webhookRequest(startUpdate('/profile', Number(TG))),
      makeDeps({}, sent),
    )
    expect(response.status).toBe(200)
    const last = sent.at(-1)!
    expect(last.chatId).toBe(TG)
    expect(last.text).toContain('DeployRankTester')
    expect(last.text).toContain('Treasury')
    expect(last.text).toContain('Gold 5,000')
    expect(last.text).toContain('Wood 1,234')
    expect(last.text).toContain('Crystal 7')
  })

  it('/profile for an unknown telegramId enlists instead of fabricating', async () => {
    const response = await handleWebhookRequest(
      webhookRequest(startUpdate('/profile', 910002663)),
      makeDeps({}, sent),
    )
    expect(response.status).toBe(200)
    expect(sent.at(-1)!.text).toContain('not enlisted')
  })

  it('/rank answers from the real season ranking path (ranked or honest fallback)', async () => {
    const response = await handleWebhookRequest(
      webhookRequest(startUpdate('/rank', Number(TG))),
      makeDeps({}, sent),
    )
    expect(response.status).toBe(200)
    const text = sent.at(-1)!.text
    const rankedOrUnavailable =
      text.includes('Season ranking') || text.includes('ranking is not available')
    expect(rankedOrUnavailable).toBe(true)
  })

  it('a RETRYABLE transport failure answers 503 so Telegram redelivers', async () => {
    const response = await handleWebhookRequest(webhookRequest(startUpdate('/start')), {
      ...makeDeps(),
      sendMessage: async () => {
        throw new TelegramDeliveryError(
          'sendMessage failed: Too Many Requests: retry after 3',
          true,
          429,
        )
      },
    })
    expect(response.status).toBe(503)
  })

  it('a PERMANENT transport failure acks 200 (no endless redelivery)', async () => {
    const response = await handleWebhookRequest(webhookRequest(startUpdate('/start')), {
      ...makeDeps(),
      sendMessage: async () => {
        throw new TelegramDeliveryError(
          'sendMessage failed: Forbidden: bot was blocked',
          false,
          403,
        )
      },
    })
    expect(response.status).toBe(200)
  })
})
