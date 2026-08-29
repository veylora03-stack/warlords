/**
 * Unit tests — route-handler pure helpers (src/lib/api/route-handler).
 * Handler integration (envelope shape, status codes) is covered by tests/e2e.
 */

import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { zodErrorToAppError, parseJsonBody, defineRoute } from '../../src/lib/api/route-handler'
import { AppError } from '../../src/lib/api/errors'

describe('zodErrorToAppError', () => {
  it('maps Zod issues into a VALIDATION_ERROR AppError with details', () => {
    const schema = z.object({ amount: z.number().int().positive(), target: z.string() })
    const result = schema.safeParse({ amount: -5 })
    expect(result.success).toBe(false)

    const appErr = zodErrorToAppError((result as { error: z.ZodError }).error)
    expect(appErr.code).toBe('VALIDATION_ERROR')
    expect(appErr.httpStatus).toBe(400)

    const details = appErr.details as { issues: Array<{ path: string; message: string }> }
    expect(details.issues.length).toBeGreaterThan(0)
    const paths = details.issues.map((i) => i.path)
    expect(paths).toContain('target')
    expect(paths).toContain('amount')
  })
})

describe('parseJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(await parseJsonBody(req)).toEqual({ a: 1 })
  })

  it('returns undefined for an empty body', async () => {
    const req = new Request('http://localhost/api/test', { method: 'POST', body: '' })
    expect(await parseJsonBody(req)).toBeUndefined()
  })

  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"a":',
    })
    try {
      await parseJsonBody(req)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('VALIDATION_ERROR')
    }
  })
})

describe('defineRoute — dynamic params (Phase 6 extension)', () => {
  it('passes Next.js-style Promise params through Zod validation to the handler', async () => {
    const handler = defineRoute({ params: z.object({ type: z.string().min(1) }) }, (ctx) => {
      return new Response(JSON.stringify({ ok: true, type: ctx.params.type }), {
        headers: { 'content-type': 'application/json' },
      })
    })

    const res = await handler(new Request('http://localhost/api/v1/x/BARRACKS/y'), {
      params: Promise.resolve({ type: 'BARRACKS' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, type: 'BARRACKS' })
  })

  it('defaults params to an empty object when the caller omits the route context', async () => {
    const handler = defineRoute({ params: z.object({ type: z.string().optional() }) }, (ctx) => {
      return new Response(JSON.stringify({ ok: true, params: ctx.params ?? null }))
    })
    const res = await handler(new Request('http://localhost/api/v1/x'))
    expect(res.status).toBe(200)
  })

  it('rejects invalid params with a VALIDATION_ERROR envelope', async () => {
    const handler = defineRoute({ params: z.object({ type: z.string().min(1) }) }, () => {
      return new Response('should not run')
    })
    const res = await handler(new Request('http://localhost/api/v1/x'), {
      params: Promise.resolve({ type: '' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('still works for static routes with no params spec (backward compatible)', async () => {
    const handler = defineRoute({}, async ({ request }) => {
      return new Response(JSON.stringify({ ok: true, path: new URL(request.url).pathname }))
    })
    const res = await handler(new Request('http://localhost/api/health'))
    expect(res.status).toBe(200)
  })
})
