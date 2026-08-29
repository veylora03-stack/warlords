/**
 * Unit tests — route-handler pure helpers (src/lib/api/route-handler).
 * Handler integration (envelope shape, status codes) is covered by tests/e2e.
 */

import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { zodErrorToAppError, parseJsonBody } from '../../src/lib/api/route-handler'
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
