/**
 * WARLORDS — Request metadata extraction helpers.
 *
 * The deployment sits behind a single trusted gateway/proxy (Caddy in the
 * sandbox; the platform edge in production). Client identity for rate
 * limiting comes from `x-forwarded-for` — the LAST entry, not the first:
 *
 *   - A proxy that REPLACES the header (header_up X-Forwarded-For {remote_host})
 *     leaves exactly one entry — client-supplied values are overwritten.
 *   - A proxy that APPENDS leaves the client's forgeable values on the LEFT
 *     and the trusted proxy's observation on the RIGHT. Taking the first
 *     entry would let any client rotate fake IPs and defeat IP-based
 *     throttling; the last entry is the only value our own infrastructure
 *     vouches for.
 *
 * Everything here is advisory metadata (logs, throttling keys) — never an
 * authorization input.
 */

const FORWARDED_FOR_HEADER = 'x-forwarded-for'

/** Best-effort client IP for rate limiting keys and audit rows. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get(FORWARDED_FOR_HEADER)
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean)
    const trusted = hops.at(-1)
    if (trusted) return trusted.slice(0, 64)
  }
  return 'unknown'
}

/** Raw User-Agent header (capped — stored on auth session rows). */
export function userAgent(request: Request): string | undefined {
  const ua = request.headers.get('user-agent')
  if (!ua) return undefined
  return ua.slice(0, 256)
}
