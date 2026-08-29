/**
 * WARLORDS — Route handler factory.
 *
 * Uniform adapter for every REST endpoint (API_DESIGN.md §contract):
 *   1. parse + Zod-validate body / query  → VALIDATION_ERROR envelope on failure
 *   2. delegate to the endpoint handler with typed (body, query, request)
 *   3. wrap with handle() → AppError/envelope mapping + structured logging
 *
 * Adapters stay thin; business rules live in services. NEVER trust the client:
 * anything arriving over HTTP must pass through a schema here or in the service.
 */

import { z } from 'zod'
import { AppError, errors } from './errors'
import { handle } from './response'

// ── Zod → AppError mapping ───────────────────────────────────────────────────

export function zodErrorToAppError(err: z.ZodError): AppError {
  const issues = err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
  return new AppError('VALIDATION_ERROR', 'Request validation failed', { issues })
}

// ── Body parsing ─────────────────────────────────────────────────────────────

/** Reads the JSON body. Empty/absent body → undefined; malformed JSON → AppError. */
export async function parseJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text()
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw errors.validation('Malformed JSON body')
  }
}

// ── Route factory ────────────────────────────────────────────────────────────

export interface RouteContext<TBody, TQuery, TParams> {
  request: Request
  body: TBody
  query: TQuery
  /** Validated dynamic path params (e.g. `[type]` segments). Empty object for static routes. */
  params: TParams
}

export interface RouteSpec<TBody, TQuery, TParams> {
  /** Zod schema for the JSON body. Omit for GET/no-body routes. */
  body?: z.ZodType<TBody>
  /** Zod schema for URL search params (values arrive as strings). */
  query?: z.ZodType<TQuery>
  /** Zod schema for the dynamic path params Next.js passes as the 2nd arg (a Promise). */
  params?: z.ZodType<TParams>
}

export type RouteHandler<TBody, TQuery, TParams> = (
  ctx: RouteContext<TBody, TQuery, TParams>,
) => Promise<Response> | Response

type LooseRouteHandler = (
  ctx: RouteContext<unknown, unknown, unknown>,
) => Promise<Response> | Response

/**
 * Creates a Next.js route handler with validation + envelope + logging wired.
 *
 * @example
 * export const POST = defineRoute({ body: attackSchema }, async ({ body, request }) => {
 *   const result = await battleService.attack(request, body)
 *   return ok(request, result)
 * })
 *
 * Dynamic segments ([type], [id]) arrive as `ctx.params` after Zod validation:
 * export const POST = defineRoute(
 *   { params: z.object({ type: z.string() }) },
 *   async ({ params, request }) => ok(request, await city.upgrade(request, params.type)),
 * )
 */
export function defineRoute<TBody = undefined, TQuery = undefined, TParams = undefined>(
  spec: RouteSpec<TBody, TQuery, TParams>,
  fn: RouteHandler<TBody, TQuery, TParams>,
): (
  request: Request,
  routeCtx?: { params?: Promise<Record<string, string>> },
) => Promise<Response> {
  return async function routeHandler(
    request: Request,
    routeCtx?: { params?: Promise<Record<string, string>> },
  ): Promise<Response> {
    return handle(request, async () => {
      let body: unknown = undefined
      let query: unknown = undefined
      let params: unknown = undefined

      if (spec.body) {
        const raw = await parseJsonBody(request)
        const parsed = spec.body.safeParse(raw)
        if (!parsed.success) throw zodErrorToAppError(parsed.error)
        body = parsed.data
      }

      if (spec.query) {
        const search = Object.fromEntries(new URL(request.url).searchParams.entries())
        const parsed = spec.query.safeParse(search)
        if (!parsed.success) throw zodErrorToAppError(parsed.error)
        query = parsed.data
      }

      if (spec.params) {
        const raw = (await routeCtx?.params) ?? {}
        const parsed = spec.params.safeParse(raw)
        if (!parsed.success) throw zodErrorToAppError(parsed.error)
        params = parsed.data
      }

      return (fn as LooseRouteHandler)({ request, body, query, params })
    })
  }
}
