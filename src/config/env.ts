/**
 * WARLORDS — Server environment configuration layer.
 *
 * SINGLE source of truth for process.env access on the server.
 * Every server module reads settings from here — direct `process.env.X`
 * reads elsewhere are review-blocking (enforced by convention, grep-able).
 *
 *  - Validated with Zod at first access → fail fast with a clear report.
 *  - `loadEnv()` is pure and testable; `getEnv()` caches the production read.
 *  - No secrets ever live in the repository: only `.env` (gitignored) and
 *    `.env.example` (template, empty values) exist.
 *
 * Client bundles must NEVER import this file — use `@/config/app` instead.
 */

import { z } from 'zod'

// ── Schema ───────────────────────────────────────────────────────────────────

const envSchema = z.object({
  /** Prisma connection string. Required — the game cannot run without it. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Structured logger threshold (src/lib/logger). */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Public base URL (bot deep links / webhook registration). Optional until Phase 1b. */
  APP_URL: z.string().min(1).optional(),

  /** Session JWT signing secret (≥32 chars). Required from Phase 1b (auth) onward. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars').optional(),

  /** Telegram bot token — server-only. Required from Phase 1b (bot) onward. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),

  /** Webhook shared secret — verified on every Telegram webhook call. */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),

  /** Admin console secret — required by admin auth (Phase 1b). */
  ADMIN_SECRET: z.string().min(1).optional(),

  /** Comma-separated Telegram user ids allowed to administer the game. */
  ADMIN_TELEGRAM_IDS: z
    .string()
    .regex(/^\s*\d+(\s*,\s*\d+)*\s*$/, 'ADMIN_TELEGRAM_IDS must be comma-separated integers')
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => Number(s.trim())) : [])),

  /**
   * Max age of Telegram initData `auth_date` — older init data is rejected
   * (bounds the replay window; the client re-opens the Mini App to refresh).
   */
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),

  /** Server-side session lifetime for issued JWT sessions. */
  SESSION_TTL_SECONDS: z.coerce.number().int().min(600).max(2_592_000).default(604_800),

  /**
   * HTTP port for the standalone production server (`next start` / Docker).
   * The dev server pins 3000 via the `dev` script; this documents + validates
   * the production knob that platform containers set for us.
   */
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),

  /**
   * Bind address for the standalone production server. Containers MUST bind
   * 0.0.0.0 (the platform router cannot reach a loopback-only server).
   */
  HOSTNAME: z.string().min(1).default('0.0.0.0'),
  /**
   * Ops kill-switch for the background notification-queue worker. Set true
   * when a DEDICATED worker instance drains the queue (multi-instance
   * deployments) or when a dev/QA server must not compete with tests that
   * drive `drainNotificationQueue` directly.
   */
  NOTIFICATION_WORKER_DISABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
})

export type RawEnv = z.infer<typeof envSchema>
export type Env = z.output<typeof envSchema> & {
  isDev: boolean
  isProd: boolean
  isTest: boolean
  /** Ops kill-switch: true disables this process's background queue worker. */
  notificationWorkerDisabled: boolean
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n` +
        'Fix .env (see .env.example). The server refuses to boot with an invalid environment.',
    )
    this.name = 'ConfigError'
    this.issues = issues
  }
}

// ── Pure loader (unit-testable) ──────────────────────────────────────────────

/**
 * Secrets that must exist before a production server may serve traffic.
 * In development they stay optional so the sandbox can boot without a real
 * bot token — auth endpoints then fail with AUTH_NOT_CONFIGURED (503).
 */
const PROD_REQUIRED = ['JWT_SECRET', 'TELEGRAM_BOT_TOKEN'] as const

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source)

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const data = result.data

  if (data.NODE_ENV === 'production') {
    const missing = PROD_REQUIRED.filter((key) => !data[key])
    if (missing.length > 0) {
      throw new ConfigError(missing.map((key) => `${key}: required in production`))
    }
  }

  return Object.freeze({
    ...data,
    isDev: data.NODE_ENV === 'development',
    isProd: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
    notificationWorkerDisabled: data.NOTIFICATION_WORKER_DISABLED,
  })
}

// ── Cached production access ─────────────────────────────────────────────────

let cached: Env | undefined

/** Validated env. Throws `ConfigError` on first call if the environment is broken. */
export function getEnv(): Env {
  cached ??= loadEnv()
  return cached
}

/** Non-throwing read for leaf infra that must work before env is available. */
export function getEnvSafe(): Env | undefined {
  try {
    return getEnv()
  } catch {
    return undefined
  }
}
