/**
 * Unit tests — structured logger (src/lib/logger).
 * Uses an injected sink so no console output leaks into test results.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createLogger, setLogLevel, setLogSink, redact, type LogLevel } from '../../src/lib/logger'

interface CapturedLine {
  level: LogLevel
  record: Record<string, unknown>
}

function capture(): { lines: CapturedLine[]; restore: () => void } {
  const lines: CapturedLine[] = []
  setLogSink((level, line) =>
    lines.push({ level, record: JSON.parse(line) as Record<string, unknown> }),
  )
  return {
    lines,
    restore: () => setLogSink(undefined),
  }
}

describe('logger', () => {
  let ctx: { lines: CapturedLine[]; restore: () => void }

  beforeEach(() => {
    ctx = capture()
    setLogLevel('debug')
  })

  afterEach(() => {
    ctx.restore()
  })

  it('emits single-line JSON with level, time, msg', () => {
    const log = createLogger()
    log.info('hello world')

    expect(ctx.lines).toHaveLength(1)
    const { record } = ctx.lines[0]!
    expect(record['level']).toBe('info')
    expect(record['msg']).toBe('hello world')
    expect(typeof record['time']).toBe('string')
    expect(new Date(record['time'] as string).getTime()).not.toBeNaN()
  })

  it('respects the minimum level threshold', () => {
    setLogLevel('warn')
    const log = createLogger()
    log.debug('hidden')
    log.info('hidden too')
    log.warn('visible')
    log.error('visible too')

    expect(ctx.lines.map((l) => l.record['msg'])).toEqual(['visible', 'visible too'])
  })

  it('child loggers keep bindings (module, requestId, playerId)', () => {
    const log = createLogger({ module: 'api' }).child({ requestId: 'req_abc123', playerId: 42 })
    log.info('attacked territory', { territoryId: 7 })

    const { record } = ctx.lines[0]!
    expect(record['module']).toBe('api')
    expect(record['requestId']).toBe('req_abc123')
    expect(record['playerId']).toBe(42)
    expect(record['territoryId']).toBe(7)
  })

  it('redacts sensitive keys at any depth', () => {
    const payload = {
      token: 'super-secret',
      telegramInitData: 'should-not-leak',
      nested: { apiKey: 'k', safe: 1 },
    }
    const log = createLogger()
    log.info('with secrets', payload)

    const { record } = ctx.lines[0]!
    expect(record['token']).toBe('[REDACTED]')
    expect(record['telegramInitData']).toBe('[REDACTED]')
    const nested = record['nested'] as Record<string, unknown>
    expect(nested['apiKey']).toBe('[REDACTED]')
    expect(nested['safe']).toBe(1)
  })

  it('serializes errors with name, message and stack under err', () => {
    const log = createLogger()
    log.error('boom', { err: new Error('db connection refused') })

    const { record } = ctx.lines[0]!
    const err = record['err'] as { name: string; message: string; stack?: string }
    expect(err.name).toBe('Error')
    expect(err.message).toBe('db connection refused')
    expect(typeof err.stack).toBe('string')
    expect(record['error']).toBeUndefined()
  })

  it('timer logs durationMs on done()', async () => {
    const log = createLogger()
    const done = log.timer('work finished', { module: 'test' })
    await Bun.sleep(15)
    done({ status: 200 })

    const { record } = ctx.lines[0]!
    expect(record['msg']).toBe('work finished')
    expect(record['durationMs']).toBeGreaterThanOrEqual(10)
    expect(record['status']).toBe(200)
  })

  it('redact() handles primitives and marks depth limit', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(5)).toBe(5)
    expect(redact(null)).toBeNull()
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
    expect(redact(deep)).toEqual({ a: { b: { c: { d: { e: '[DEPTH_LIMIT]' } } } } })
  })
})
