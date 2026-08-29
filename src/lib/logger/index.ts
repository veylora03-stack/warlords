/**
 * WARLORDS — Structured JSON logger.
 *
 * Contract (BACKEND_ARCHITECTURE.md): single-line JSON per event —
 *   { level, time, module?, requestId?, playerId?, msg, durationMs?, err? }
 *
 * Rules:
 *  - No secrets: values whose keys look sensitive are redacted in-place.
 *  - No initData / tokens / full IPs are ever logged.
 *  - Audit truth lives in DB ledgers (resource_transactions, admin_audit_logs),
 *    never in logs — logs are for operations, not for bookkeeping.
 *  - Leaf infra: imports nothing game-related. Level comes from LOG_LEVEL
 *    (config layer) with a safe fallback, overridable in tests via setLogLevel.
 */

import { getEnvSafe } from '@/config/env'

// ── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogBindings {
  module?: string
  requestId?: string
  playerId?: number | string
  [key: string]: string | number | boolean | null | undefined
}

export interface SerializedError {
  name: string
  message: string
  code?: string
  stack?: string
}

export type LogSink = (level: LogLevel, line: string) => void

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// ── Sink + level (overridable for tests) ─────────────────────────────────────

const defaultSink: LogSink = (level, line) => {
  if (level === 'debug') console.log(line)
  else if (level === 'info') console.info(line)
  else if (level === 'warn') console.warn(line)
  else console.error(line)
}

let sink: LogSink = defaultSink
let minLevel: LogLevel = getEnvSafe()?.LOG_LEVEL ?? 'info'

export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? defaultSink
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SENSITIVE_KEY = /token|secret|password|authorization|initdata|cookie|apikey|api_key/i
const REDACTED = '[REDACTED]'

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[DEPTH_LIMIT]'
  if (value === null || typeof value !== 'object') return value

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1)
  }
  return out
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const maybeCode: unknown = (err as { code?: unknown }).code
    return {
      name: err.name,
      message: err.message,
      code: typeof maybeCode === 'string' ? maybeCode : undefined,
      stack: err.stack,
    }
  }
  return { name: 'NonError', message: String(err) }
}

// ── Core ─────────────────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** Returns a done() function that logs `msg` with durationMs at info level. */
  timer(
    msg: string,
    fields?: Record<string, unknown>,
  ): (resultFields?: Record<string, unknown>) => void
  child(bindings: LogBindings): Logger
}

export function createLogger(bindings: LogBindings = {}): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return

    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      ...(bindings.requestId !== undefined ? { requestId: bindings.requestId } : {}),
      ...(bindings.playerId !== undefined ? { playerId: bindings.playerId } : {}),
      ...(bindings.module !== undefined ? { module: bindings.module } : {}),
      msg,
      ...(redact(fields) as Record<string, unknown>),
    }

    const errField = fields?.['err'] ?? fields?.['error']
    if (errField !== undefined && errField !== null) {
      record['err'] = serializeError(errField)
      delete record['error']
    }

    sink(level, JSON.stringify(record))
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    timer: (msg, fields) => {
      const startedAt = Date.now()
      return (resultFields?: Record<string, unknown>) =>
        write('info', msg, { ...fields, ...resultFields, durationMs: Date.now() - startedAt })
    },
    child: (extra) => createLogger({ ...bindings, ...extra }),
  }
}

/** Root logger. Prefer `createLogger({ module })` at call sites. */
export const logger: Logger = createLogger()
