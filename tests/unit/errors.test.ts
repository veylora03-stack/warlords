/**
 * Unit tests — AppError taxonomy (src/lib/api/errors).
 */

import { describe, it, expect } from 'bun:test'
import { AppError, errors, ERROR_CODES } from '../../src/lib/api/errors'

describe('AppError', () => {
  it('maps error codes to the correct HTTP status', () => {
    const unauthorized = new AppError('UNAUTHORIZED', 'Authentication required')
    expect(unauthorized.httpStatus).toBe(401)
    expect(unauthorized.code).toBe('UNAUTHORIZED')

    const cooldown = new AppError('ACTION_ON_COOLDOWN', 'Wait 30s')
    expect(cooldown.httpStatus).toBe(429)
  })

  it('carries details through toLog()', () => {
    const err = new AppError('INSUFFICIENT_GOLD', 'Not enough gold', { needed: 100, have: 40 })
    expect(err.toLog()).toEqual({
      code: 'INSUFFICIENT_GOLD',
      httpStatus: 409,
      details: { needed: 100, have: 40 },
    })
  })

  it('is an instanceof Error with AppError name', () => {
    const err = errors.forbidden()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AppError)
    expect(err.name).toBe('AppError')
  })
})

describe('errors factory', () => {
  it('errors.insufficient builds the right per-resource code', () => {
    const err = errors.insufficient('wood', 200, 50)
    expect(err.code).toBe('INSUFFICIENT_WOOD')
    expect(err.httpStatus).toBe(409)
    expect(err.details).toEqual({ needed: 200, have: 50 })
    expect(err.message).toContain('need 200')
  })

  it('errors.insufficient rejects unknown resources as INTERNAL_ERROR', () => {
    const err = errors.insufficient('diamonds<><>', 1, 0)
    expect(err.code).toBe('INTERNAL_ERROR')
  })

  it('validation helper attaches details', () => {
    const err = errors.validation('bad input', { field: 'amount' })
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.httpStatus).toBe(400)
    expect(err.details).toEqual({ field: 'amount' })
  })

  it('every declared code resolves to a valid HTTP status', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect([400, 401, 403, 404, 409, 429, 500]).toContain(status)
    }
  })
})
