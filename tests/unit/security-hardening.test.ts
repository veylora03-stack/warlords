/**
 * Unit tests — Phase 23 security hardening regressions.
 *
 * Each test pins ONE fixed vulnerability at the pure-function level:
 *  - BODY_TOO_LARGE: oversized JSON is rejected BEFORE JSON.parse
 *  - FORBIDDEN_ORIGIN: cross-site Origin on unsafe methods is rejected
 *  - clientIp: the LAST x-forwarded-for hop (the trusted proxy's view) is
 *    used — a client-rotated FIRST hop can no longer defeat rate limiting
 *  - principal rate-limit groups: identity-keyed budgets exhaust at limit
 */

import { describe, it, expect } from 'bun:test'
import { parseJsonBody, defineRoute, REQUEST_BODY_MAX_BYTES } from '../../src/lib/api/route-handler'
import { AppError } from '../../src/lib/api/errors'
import { clientIp } from '../../src/lib/api/request-info'
import { enforcePrincipalRateLimit } from '../../src/lib/rate-limit'

describe('parseJsonBody — body size ceiling (413 before parse)', () => {
  it('accepts a body just under the ceiling', async () => {
    const ok = JSON.stringify({ blob: 'x'.repeat(REQUEST_BODY_MAX_BYTES - 64) })
    const req = new Request('http://localhost/api/test', { method: 'POST', body: ok })
    const parsed = (await parseJsonBody(req)) as { blob: string }
    expect(parsed.blob.length).toBe(REQUEST_BODY_MAX_BYTES - 64)
  })

  it('rejects an oversized body with BODY_TOO_LARGE 413 — before JSON parsing', async () => {
    // Malformed JSON that is ALSO oversized: the size check must fire first,
    // proving the guard is not downstream of the parser (memory exhaustion
    // happens in the parser, not in Zod).
    const oversized = '{"a":"' + 'x'.repeat(REQUEST_BODY_MAX_BYTES)
    const req = new Request('http://localhost/api/test', { method: 'POST', body: oversized })
    try {
      await parseJsonBody(req)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe('BODY_TOO_LARGE')
      expect(appErr.httpStatus).toBe(413)
      expect((appErr.details as { maxBytes?: number }).maxBytes).toBe(REQUEST_BODY_MAX_BYTES)
    }
  })
})

describe('defineRoute — cross-site Origin rejection (CSRF defense-in-depth)', () => {
  const POST = defineRoute({}, async () => new Response('{"ok":true}', { status: 200 }))

  it('rejects a POST whose Origin host differs from the request host', async () => {
    const req = new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      body: '{"initData":"x"}',
      headers: { origin: 'https://evil.example' },
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('rejects a PATCH/PUT/DELETE with a foreign Origin too', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const req = new Request('http://localhost:3000/api/x', {
        method,
        body: '{}',
        headers: { origin: 'https://evil.example' },
      })
      const res = await POST(req)
      expect(res.status).toBe(403)
    }
  })

  it('allows a POST whose Origin matches the host (Mini App same-origin fetch)', async () => {
    // The handler is unreachable (no auth wiring here) — what matters is
    // that the failure is NOT the origin guard: a bare handler runs.
    const req = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      body: '{}',
      headers: { origin: 'http://localhost:3000' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('allows requests without an Origin header (native bearer clients, tests)', async () => {
    const req = new Request('http://localhost:3000/api/x', { method: 'POST', body: '{}' })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('ignores a foreign Origin on GET/HEAD (safe methods cannot mutate)', async () => {
    const GET = defineRoute({}, async () => new Response('{"ok":true}', { status: 200 }))
    const req = new Request('http://localhost:3000/api/x', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
  })
})

describe('clientIp — last trusted proxy hop', () => {
  it('uses the LAST x-forwarded-for entry, not the client-forgeable first', () => {
    const req = new Request('http://localhost/api/x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 10.0.0.99' },
    })
    // 1.2.3.4 / 5.6.7.8 are attacker-supplied garbage; 10.0.0.99 is what
    // OUR gateway observed (appended/replaced by the trusted proxy).
    expect(clientIp(req)).toBe('10.0.0.99')
  })

  it('returns the single entry when the gateway replaced the header', () => {
    const req = new Request('http://localhost/api/x', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('falls back to "unknown" without the header (documented shared bucket)', () => {
    expect(clientIp(new Request('http://localhost/api/x'))).toBe('unknown')
  })

  it('ignores blank hops and caps the stored length', () => {
    const req = new Request('http://localhost/api/x', {
      headers: { 'x-forwarded-for': `  ,  , ${'a'.repeat(200)}bb` },
    })
    expect(clientIp(req)).toHaveLength(64)
  })
})

describe('enforcePrincipalRateLimit — identity-keyed group budgets', () => {
  it('exhausts the adminBroadcast budget (5/min) and throws RATE_LIMITED', () => {
    const id = `broadcast-test-${Math.random().toString(36).slice(2, 8)}`
    for (let i = 0; i < 5; i++) {
      expect(() => enforcePrincipalRateLimit(id, 'adminBroadcast')).not.toThrow()
    }
    try {
      enforcePrincipalRateLimit(id, 'adminBroadcast')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe('RATE_LIMITED')
      expect(appErr.httpStatus).toBe(429)
      expect((appErr.details as { limit?: number }).limit).toBe(5)
    }
  })

  it('keys budgets per identity — another principal is unaffected', () => {
    const exhausted = `group-test-${Math.random().toString(36).slice(2, 8)}`
    const fresh = `group-test-${Math.random().toString(36).slice(2, 8)}`
    for (let i = 0; i < 5; i++) enforcePrincipalRateLimit(exhausted, 'adminBroadcast')
    expect(() => enforcePrincipalRateLimit(fresh, 'adminBroadcast')).not.toThrow()
  })

  it('gives the standard backstop a generous budget (300/min)', () => {
    const id = `standard-test-${Math.random().toString(36).slice(2, 8)}`
    for (let i = 0; i < 300; i++) {
      expect(() => enforcePrincipalRateLimit(id, 'standard')).not.toThrow()
    }
    expect(() => enforcePrincipalRateLimit(id, 'standard')).toThrow(AppError)
  })
})
