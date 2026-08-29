/**
 * WARLORDS — Request metadata extraction helpers.
 *
 * The deployment sits behind a gateway/proxy, so client identity for rate
 * limiting comes from `x-forwarded-for` (first hop). Everything here is
 * advisory metadata (logs, throttling) — never authorization input.
 */

const FORWARDED_FOR_HEADER = 'x-forwarded-for'

/** Best-effort client IP for rate limiting keys and audit rows. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get(FORWARDED_FOR_HEADER)
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
  }
  return 'unknown'
}

/** Raw User-Agent header (capped — stored on auth session rows). */
export function userAgent(request: Request): string | undefined {
  const ua = request.headers.get('user-agent')
  if (!ua) return undefined
  return ua.slice(0, 256)
}
