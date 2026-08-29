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

export interface RouteContext<TBody, TQuery> {
  request: Request
  body: TBody
  query: TQuery
}

export interface RouteSpec<TBody, TQuery> {
  /** Zod schema for the JSON body. Omit for GET/no-body routes. */
  body?: z.ZodType<TBody>
  /** Zod schema for URL search params (values arrive as strings). */
  query?: z.ZodType<TQuery>
}

export type RouteHandler<TBody, TQuery> = (
  ctx: RouteContext<TBody, TQuery>,
) => Promise<Response> | Response

type LooseRouteHandler = (ctx: RouteContext<unknown, unknown>) => Promise<Response> | Response

/**
 * Creates a Next.js route handler with validation + envelope + logging wired.
 *
 * @example
 * export const POST = defineRoute({ body: attackSchema }, async ({ body, request }) => {
 *   const result = await battleService.attack(request, body)
 *   return ok(request, result)
 * })
 */
export function defineRoute<TBody = undefined, TQuery = undefined>(
  spec: RouteSpec<TBody, TQuery>,
  fn: RouteHandler<TBody, TQuery>,
): (request: Request) => Promise<Response> {
  return async function routeHandler(request: Request): Promise<Response> {
    return handle(request, async () => {
      let body: unknown = undefined
      let query: unknown = undefined

      if (spec.body) {
        const raw = await parseJsonBody(request)
        const parsed = spec.body.safeParse(raw)
        if (!parsed.success) throw zodErrorToAppError(parsed.error)
        body = parsed.data
      }

      if (spec.query) {
        const params = Object.fromEntries(new URL(request.url).searchParams.entries())
        const parsed = spec.query.safeParse(params)
        if (!parsed.success) throw zodErrorToAppError(parsed.error)
        query = parsed.data
      }

      return (fn as LooseRouteHandler)({ request, body, query })
    })
  }
}
