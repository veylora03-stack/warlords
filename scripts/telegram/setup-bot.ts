/**
 * WARLORDS — Telegram bot production setup (Phase 26).
 *
 * Configures the production bot against the REAL Telegram Bot API:
 *   bun scripts/telegram/setup-bot.ts                configure: setWebhook + setMyCommands + setChatMenuButton
 *   bun scripts/telegram/setup-bot.ts --status       inspect only (getMe + getWebhookInfo)
 *   bun scripts/telegram/setup-bot.ts --delete       teardown: deleteWebhook (rollback switch)
 *   … --drop-pending                                 configure/delete also drops queued undelivered updates
 *
 * Required env (validated by the shared env layer — no direct process.env
 * reads in app code): TELEGRAM_BOT_TOKEN · APP_URL (public HTTPS base of the
 * deployment) · TELEGRAM_WEBHOOK_SECRET. In production mode APP_URL must be
 * https:// (Telegram refuses insecure webhooks).
 *
 * Exit codes: 0 success · 1 configuration error · 2 Bot API failure.
 */

import { getEnv } from '../../src/config/env'
import { BOT_COMMANDS } from '../../src/lib/telegram/bot'

const API_BASE = 'https://api.telegram.org'
const WEBHOOK_PATH = '/api/v1/telegram/webhook'
const HTTP_TIMEOUT_MS = 15_000
const ALLOWED_UPDATES = ['message', 'callback_query'] as const
const MENU_BUTTON_TEXT = '⚔️ WARLORDS'

interface BotApiResult<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

async function callBotApi<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  let parsed: BotApiResult<T>
  try {
    parsed = (await response.json()) as BotApiResult<T>
  } catch {
    throw new Error(`${method}: non-JSON response (HTTP ${response.status})`)
  }
  if (!response.ok || !parsed.ok || parsed.result === undefined) {
    throw new Error(`${method} failed: ${parsed.description ?? `HTTP ${response.status}`}`)
  }
  return parsed.result
}

function maskToken(token: string): string {
  return token.length <= 10 ? '***' : `${token.slice(0, 6)}…${token.slice(-4)}`
}

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

interface WebhookInfo {
  url: string
  has_custom_certificate: boolean
  pending_update_count: number
  last_error_date?: number
  last_error_message?: string
  ip_address?: string
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--status')
    ? 'status'
    : argv.includes('--delete')
      ? 'delete'
      : 'configure'
  const dropPending = argv.includes('--drop-pending')

  const env = getEnv()
  if (!env.TELEGRAM_BOT_TOKEN) fail('TELEGRAM_BOT_TOKEN is not set (get it from @BotFather).')
  const token = env.TELEGRAM_BOT_TOKEN
  console.log(`bot token: ${maskToken(token)}`)

  const me = await callBotApi<{ id: number; username?: string; first_name: string }>(token, 'getMe')
  const botHandle = me.username ? `@${me.username}` : me.first_name
  console.log(`bot identity: ${botHandle} (id ${me.id})`)

  if (mode === 'status') {
    const info = await callBotApi<WebhookInfo>(token, 'getWebhookInfo')
    console.log('webhook info:')
    console.log(`  url: ${info.url.length > 0 ? info.url : '(none — long-poll mode)'}`)
    console.log(`  pending updates: ${info.pending_update_count}`)
    if (info.last_error_message) {
      console.log(`  last delivery error: ${info.last_error_message}`)
    }
    console.log(`  commands advertised: ${BOT_COMMANDS.map((c) => `/${c.command}`).join(' ')}`)
    return
  }

  if (mode === 'delete') {
    await callBotApi(token, 'deleteWebhook', {
      ...(dropPending ? { drop_pending_updates: true } : {}),
    })
    console.log('✓ webhook deleted — the bot stops receiving updates (rollback done).')
    return
  }

  // ── configure ─────────────────────────────────────────────────────────────
  if (!env.APP_URL) fail('APP_URL is not set — the public HTTPS base URL of this deployment.')
  if (!env.TELEGRAM_WEBHOOK_SECRET)
    fail('TELEGRAM_WEBHOOK_SECRET is not set (openssl rand -hex 32).')
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
    fail('TELEGRAM_WEBHOOK_SECRET must be 1–256 chars of [A-Za-z0-9_-] (Telegram requirement).')
  }
  const baseUrl = env.APP_URL.replace(/\/+$/, '')
  if (env.isProd && !baseUrl.startsWith('https://')) {
    fail('APP_URL must start with https:// in production — Telegram requires a valid TLS webhook.')
  }
  const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`

  await callBotApi(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    ...(dropPending ? { drop_pending_updates: true } : {}),
  })
  console.log(`✓ webhook set: POST ${webhookUrl}`)
  console.log(
    `  allowed_updates: ${ALLOWED_UPDATES.join(', ')} (secret_token: configured, not printed)`,
  )

  await callBotApi(token, 'setMyCommands', {
    commands: BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })),
  })
  console.log(`✓ commands registered: ${BOT_COMMANDS.map((c) => `/${c.command}`).join(' ')}`)

  await callBotApi(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url: baseUrl } },
  })
  console.log(`✓ menu button: "${MENU_BUTTON_TEXT}" → Mini App ${baseUrl}`)

  const info = await callBotApi<WebhookInfo>(token, 'getWebhookInfo')
  console.log('final webhook state:')
  console.log(`  url: ${info.url === webhookUrl ? webhookUrl : `UNEXPECTED (${info.url})`}`)
  console.log(`  pending updates: ${info.pending_update_count}`)
  if (info.url !== webhookUrl) process.exit(2)
}

main().catch((cause: unknown) => {
  console.error(
    `✗ setup aborted: ${cause instanceof Error ? cause.message : String(cause)}\n` +
      '  (exit 2 — Bot API/network failure; nothing was left half-configured beyond the steps already printed above)',
  )
  process.exit(2)
})
