/**
 * WARLORDS — Telegram webhook pipeline (Phase 26).
 *
 * The production bot delivery mode (TELEGRAM_ARCHITECTURE.md §2):
 *   setWebhook(url=APP_URL/api/v1/telegram/webhook, secret_token=…) and
 *   Telegram delivers updates with `X-Telegram-Bot-Api-Secret-Token`.
 *
 * Pipeline: secret gate → bounded read → parse → command router → reply.
 *
 * Status-code contract (deliberately NOT the standard envelope — Telegram
 * is a machine caller with its own retry policy):
 *   401 — secret header missing/mismatched (constant-time compared)
 *   503 — transport not configured, or a RETRYABLE send failure
 *         (Telegram re-delivers the same update with backoff; command
 *         handling is read-only and idempotent, so redelivery is safe)
 *   200 — everything else, including malformed updates and permanent send
 *         failures: acking garbage prevents retry storms, permanent
 *         failures are logged for ops instead of retried forever.
 *
 * Privacy: message text is never logged — only update_id and the command
 * word. Message bodies are dropped after routing.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { getEnv } from '@/config/env'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import { REQUEST_BODY_MAX_BYTES } from '@/lib/api/route-handler'
import { getSeasonRankingView } from '@/lib/game/services/season.service'
import {
  createBotRouter,
  telegramUpdateSchema,
  type BotPlayerSnapshot,
  type BotRankingSnapshot,
  type BotReply,
  type BotRouter,
  type BotRouterDeps,
} from './bot'
import { sendTelegramMessage, TelegramDeliveryError } from './send-message'

const log = logger.child({ module: 'telegram/webhook' })

export const TELEGRAM_WEBHOOK_HEADER = 'x-telegram-bot-api-secret-token'

/**
 * Constant-time secret comparison. Both sides are hashed to a fixed-length
 * digest first — timingSafeEqual throws on length mismatch, and hashing
 * removes any length signal from the attacker's side.
 */
export function verifyWebhookSecret(received: string | null, expected: string): boolean {
  if (!received || received.length === 0 || expected.length === 0) return false
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(received), digest(expected))
}

// ── Real data loaders (the bot runs in-process with the API's Prisma) ───────

export async function loadPlayerSnapshotByTelegramId(
  telegramId: string,
): Promise<BotPlayerSnapshot | null> {
  const user = await db.user.findUnique({
    where: { telegramId },
    select: {
      player: {
        select: {
          id: true,
          name: true,
          level: true,
          power: true,
          seasonPoints: true,
          wallet: { select: { gold: true, wood: true, iron: true, food: true, crystal: true } },
        },
      },
    },
  })
  const player = user?.player
  if (!player) return null
  return {
    playerId: player.id,
    name: player.name,
    level: player.level,
    power: player.power,
    seasonPoints: player.seasonPoints,
    wallet: player.wallet,
  }
}

export async function loadRankingSnapshot(playerId: string): Promise<BotRankingSnapshot | null> {
  try {
    const view = await getSeasonRankingView(playerId, 5)
    return {
      me: view.me,
      top: view.live.slice(0, 5).map((row) => ({
        rank: row.rank,
        playerName: row.playerName,
        score: row.score,
      })),
    }
  } catch (cause) {
    log.warn('bot ranking snapshot unavailable', {
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return null
  }
}

// ── Injectable pipeline deps (tests override; route uses the real ones) ─────

export interface WebhookDeps {
  botToken: string | null
  webhookSecret: string | null
  router: BotRouter
  sendMessage: typeof sendTelegramMessage
}

export function createDefaultWebhookDeps(): WebhookDeps {
  const env = getEnv()
  const routerDeps: BotRouterDeps = {
    appUrl: env.APP_URL ?? null,
    getSnapshotByTelegramId: loadPlayerSnapshotByTelegramId,
    getRankingSnapshot: loadRankingSnapshot,
  }
  return {
    botToken: env.TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
    router: createBotRouter(routerDeps),
    sendMessage: sendTelegramMessage,
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

function telegramReply(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export async function handleWebhookRequest(
  request: Request,
  deps: WebhookDeps = createDefaultWebhookDeps(),
): Promise<Response> {
  if (!deps.botToken || !deps.webhookSecret) {
    log.warn('telegram webhook disabled — bot transport not configured on this deployment')
    return telegramReply({ ok: false, code: 'BOT_NOT_CONFIGURED' }, 503)
  }

  if (!verifyWebhookSecret(request.headers.get(TELEGRAM_WEBHOOK_HEADER), deps.webhookSecret)) {
    log.warn('telegram webhook rejected — missing or mismatched secret token')
    return telegramReply({ ok: false, code: 'FORBIDDEN' }, 401)
  }

  // Bounded read — the same 64 KiB cap the API applies to every other caller.
  const raw = await request.text()
  if (raw.length > REQUEST_BODY_MAX_BYTES) {
    log.warn('telegram webhook dropped oversized body', { bytes: raw.length })
    return telegramReply({ ok: true })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    log.warn('telegram webhook dropped non-JSON body')
    return telegramReply({ ok: true })
  }

  const parsed = telegramUpdateSchema.safeParse(parsedJson)
  if (!parsed.success) {
    log.warn('telegram webhook dropped malformed update')
    return telegramReply({ ok: true })
  }
  const update = parsed.data

  const message = update.message
  const text = message?.text?.trim()
  if (message && text && text.startsWith('/') && message.from.is_bot !== true) {
    const telegramId = String(message.from.id)
    const commandWord = text.split(/\s+/)[0]!.slice(0, 32)
    log.info('bot command received', { updateId: update.update_id, command: commandWord })

    let reply: BotReply
    try {
      reply = await deps.router.handleCommand(telegramId, text, {
        firstName: message.from.first_name,
      })
    } catch (cause) {
      // Handler bugs are deterministic — redelivery would just storm. Ack and alert ops.
      log.error('bot command handler failed', {
        updateId: update.update_id,
        command: commandWord,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return telegramReply({ ok: true })
    }

    try {
      await deps.sendMessage({
        token: deps.botToken,
        chatId: telegramId,
        text: reply.text,
        replyMarkup: reply.replyMarkup,
      })
    } catch (cause) {
      if (cause instanceof TelegramDeliveryError && cause.retryable) {
        // 503 → Telegram redelivers the SAME update with backoff (bounded retries).
        log.warn('telegram send failed retryably — deferring to redelivery', {
          updateId: update.update_id,
          httpStatus: cause.httpStatus,
        })
        return telegramReply({ ok: false, code: 'TELEGRAM_UNAVAILABLE' }, 503)
      }
      log.error('telegram send failed permanently', {
        updateId: update.update_id,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return telegramReply({ ok: true })
    }
  }
  // callback_query updates: acknowledged (no interactive keyboards yet — the
  // only keyboard is the static web_app button, which needs no callback).

  return telegramReply({ ok: true })
}
