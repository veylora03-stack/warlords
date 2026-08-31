/**
 * WARLORDS — POST /api/v1/telegram/webhook (Phase 26).
 *
 * Telegram → Bot API webhook adapter (TELEGRAM_ARCHITECTURE.md §2).
 * Configured against the production bot by scripts/telegram/setup-bot.ts:
 *   setWebhook(url=APP_URL/api/v1/telegram/webhook, secret_token=TELEGRAM_WEBHOOK_SECRET)
 *
 * Status contract (Telegram is a machine caller — no envelope here):
 *   401 secret mismatch · 503 unconfigured/retryable-send-failure · 200 ack.
 * The full pipeline lives in the telegram module (src/lib/telegram/…).
 */

import { handleWebhookRequest } from '@/lib/telegram/webhook.service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function POST(request: Request): Promise<Response> {
  return handleWebhookRequest(request)
}
