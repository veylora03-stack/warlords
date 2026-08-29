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
})

export type RawEnv = z.infer<typeof envSchema>
export type Env = z.output<typeof envSchema> & {
  isDev: boolean
  isProd: boolean
  isTest: boolean
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

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source)

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.')
      return `${path || '(root)'}: ${issue.message}`
    })
    throw new ConfigError(issues)
  }

  return Object.freeze({
    ...result.data,
    isDev: result.data.NODE_ENV === 'development',
    isProd: result.data.NODE_ENV === 'production',
    isTest: result.data.NODE_ENV === 'test',
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
