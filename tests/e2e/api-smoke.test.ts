/**
 * E2E API smoke tests — run against a REAL running server.
 *
 * Prerequisite: dev or production server on :3000 (or E2E_BASE_URL).
 *   bun run dev            # in another shell
 *   bun run test:e2e
 *
 * These tests verify the public HTTP contract end-to-end: envelope shape,
 * request-id propagation, real DB probe, and the page shell — no mocks.
 */

import { describe, it, expect } from 'bun:test'
import type { ApiEnvelope } from '../../src/types/api'

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000'

/**
 * Reachability is probed at module load (top-level await) because
 * describe.skipIf() captures its condition at registration time —
 * a beforeAll() check would run too late and silently skip everything.
 */
const serverReachable = await fetch(`${BASE_URL}/api/health`, {
  signal: AbortSignal.timeout(5000),
})
  .then(() => true)
  .catch(() => {
    console.error(
      `\n[e2e] No server at ${BASE_URL}. Start it first:  bun run dev\n` +
        '[e2e] (or point E2E_BASE_URL at another instance)\n',
    )
    return false
  })

describe.skipIf(!serverReachable)('GET /api/health', () => {
  it('returns 200 with the success envelope and a real DB probe', async () => {
    const res = await fetch(`${BASE_URL}/api/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('x-request-id')).toMatch(/^req_/)

    const body = (await res.json()) as ApiEnvelope<{
      status: string
      app: string
      db: string
      dbLatencyMs: number | null
      uptimeSec: number
      version: string
      phase: number
    }>

    expect(body.ok).toBe(true)
    if (!body.ok) return // type narrowing
    expect(body.data.app).toBe('warlords')
    expect(body.data.db).toBe('up')
    expect(body.data.dbLatencyMs).not.toBeNull()
    expect(body.data.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(typeof body.data.version).toBe('string')
    expect(body.meta.requestId).toMatch(/^req_/)
    expect(typeof body.meta.serverTime).toBe('string')
  })
})

describe.skipIf(!serverReachable)('GET /api (index)', () => {
  it('lists the endpoint surface with envelope documentation', async () => {
    const res = await fetch(`${BASE_URL}/api`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as ApiEnvelope<{
      service: string
      endpoints: Record<string, string>
      envelope: Record<string, string>
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.service).toBe('warlords')
    expect(body.data.endpoints['health']).toBe('/api/health')
  })
})

describe.skipIf(!serverReachable)('GET / (console shell)', () => {
  it('serves the WARLORDS console HTML', async () => {
    const res = await fetch(`${BASE_URL}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('WARLORDS')
  })
})

describe.skipIf(!serverReachable)('Phase 26 deployment probes', () => {
  it('GET /health — liveness: 200, dependency-free body, no-store', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['app']).toBe('warlords')
    expect(body['db']).toBeUndefined()
  })

  it('GET /ready — readiness: 200 ready with a real DB round-trip', async () => {
    const res = await fetch(`${BASE_URL}/ready`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      checks: { db: { status: string }; config: { status: string } }
    }
    expect(body.status).toBe('ready')
    expect(body.checks.db.status).toBe('up')
  })

  it('POST /api/v1/telegram/webhook — unauthenticated callers are rejected', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    })
    // 401 (secret mismatch) on a configured transport, 503 (unconfigured) on
    // sandbox — both are the typed contracts; everything else is a defect.
    expect([401, 503]).toContain(res.status)
  })
})
