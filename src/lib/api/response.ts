/**
 * WARLORDS — Standard API response envelope.
 *
 * Every endpoint (success or failure) returns:
 *   { ok: true,  data, meta? }  |  { ok: false, error: { code, message, details? }, meta }
 *
 * BigInt values are serialized as strings via `serializeJson` — clients treat
 * amounts as opaque display strings, never as float math inputs.
 */

import { NextResponse } from 'next/server'
import { AppError, type ErrorDetails } from './errors'

export interface ApiMeta {
  requestId: string
  serverTime: string
  page?: number
  total?: number
}

export interface ApiSuccess<T> {
  ok: true
  data: T
  meta: ApiMeta
}

export interface ApiErrorBody {
  ok: false
  error: { code: string; message: string; details?: ErrorDetails }
  meta: ApiMeta
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiErrorBody

// ── BigInt-safe JSON serialization ───────────────────────────────────────────

export function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString()
    return v
  })
}

// ── Request id ───────────────────────────────────────────────────────────────

export function getRequestId(request: Request): string {
  const inbound = request.headers.get('x-request-id')
  if (inbound && /^[A-Za-z0-9_-]{6,64}$/.test(inbound)) return inbound
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function meta(request: Request, extra?: Partial<ApiMeta>): ApiMeta {
  return {
    requestId: getRequestId(request),
    serverTime: new Date().toISOString(),
    ...extra,
  }
}

// ── Builders ─────────────────────────────────────────────────────────────────

export function ok<T>(
  request: Request,
  data: T,
  options?: { status?: number; meta?: Partial<ApiMeta>; headers?: HeadersInit },
): NextResponse {
  const body: ApiSuccess<T> = { ok: true, data, meta: meta(request, options?.meta) }
  return new NextResponse(serializeJson(body), {
    status: options?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': body.meta.requestId,
      ...options?.headers,
    },
  })
}

export function fail(
  request: Request,
  error: AppError,
  options?: { headers?: HeadersInit },
): NextResponse {
  const body: ApiErrorBody = {
    ok: false,
    error: { code: error.code, message: error.message, details: error.details },
    meta: meta(request),
  }
  return new NextResponse(serializeJson(body), {
    status: error.httpStatus,
    headers: {
      'content-type': 'application/json',
      'x-request-id': body.meta.requestId,
      ...options?.headers,
    },
  })
}

/** Catch-all wrapper for route handlers — unexpected errors never leak stacks. */
export async function handle(
  request: Request,
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AppError) return fail(request, err)
    // Unknown error: log server-side, return generic 500.
    console.error(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        requestId: getRequestId(request),
        module: 'api',
        msg: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    )
    return fail(request, new AppError('INTERNAL_ERROR', 'Internal server error'))
  }
}
