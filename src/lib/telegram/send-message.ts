/**
 * WARLORDS — Telegram Bot API message transport (Phase 22).
 *
 * The REAL push channel of the notification engine. `sendTelegramMessage`
 * performs an actual Bot API `sendMessage` call — no mocks, no stubs. The
 * channel is a CAPABILITY: when TELEGRAM_BOT_TOKEN is absent (sandbox/dev),
 * `resolveTelegramDeliveryConfig` reports it unconfigured and the engine
 * marks the delivery SKIPPED with an explicit reason — a fake success would
 * be indistinguishable from a delivered push, which is exactly what this
 * module refuses to do.
 *
 * Failure classification (drives the queue's retry policy):
 *   - 429 / 5xx / network errors → RETRYABLE (backoff, bounded attempts)
 *   - 400/403/404 (bad request, bot blocked, chat not found) → PERMANENT
 *     (retrying a blocked bot forever would only poison the queue)
 */

import { getEnvSafe } from '@/config/env'
import { NOTIFICATION_POLICY } from '@/lib/game/config/notifications'

const TELEGRAM_API_BASE = 'https://api.telegram.org'

export interface TelegramDeliveryConfig {
  /** null → the push channel is not configured on this deployment. */
  token: string | null
}

/** Reads the (optional) bot capability from the validated env. */
export function resolveTelegramDeliveryConfig(): TelegramDeliveryConfig {
  const env = getEnvSafe()
  return { token: env?.TELEGRAM_BOT_TOKEN ?? null }
}

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'TelegramDeliveryError'
  }
}

/** Pure classifier — unit-tested. */
export function isRetryableTelegramStatus(status: number): boolean {
  return status === 429 || status >= 500
}

interface TelegramApiResponse {
  ok: boolean
  description?: string
}

/**
 * Sends one message through the Telegram Bot API. Throws
 * TelegramDeliveryError on any failure with `retryable` set so the worker
 * can decide between backoff-retry and terminal FAILED.
 *
 * `replyMarkup` (Phase 26) carries an inline keyboard (e.g. the Mini App
 * web_app button) — optional, so the notification engine path is unchanged.
 */
export async function sendTelegramMessage(
  input: {
    token: string
    chatId: string
    text: string
    replyMarkup?: object
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${TELEGRAM_API_BASE}/bot${input.token}/sendMessage`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
        ...(input.replyMarkup !== undefined ? { reply_markup: input.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(NOTIFICATION_POLICY.telegramHttpTimeoutMs),
    })
  } catch (cause) {
    // Timeout, DNS, connection reset — transient by nature.
    throw new TelegramDeliveryError(
      `Telegram request failed: ${cause instanceof Error ? cause.message : 'network error'}`,
      true,
    )
  }

  let parsed: TelegramApiResponse | null = null
  try {
    parsed = (await response.json()) as TelegramApiResponse
  } catch {
    // Non-JSON body — fall through to the status check.
  }

  if (!response.ok || !parsed?.ok) {
    const description = parsed?.description ?? `HTTP ${response.status}`
    throw new TelegramDeliveryError(
      `Telegram sendMessage failed: ${description}`,
      isRetryableTelegramStatus(response.status),
      response.status,
    )
  }
}
