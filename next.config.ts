import type { NextConfig } from 'next'

/**
 * Security headers (Phase 23 audit).
 *
 * - CSP `frame-ancestors` — a Telegram Mini App MUST be framable by the
 *   Telegram clients, and by nothing else: no arbitrary-site clickjacking
 *   of the player UI or the admin panel. (X-Frame-Options is deliberately
 *   NOT set — it cannot express the Telegram allowlist and would either
 *   break embedding or be redundant with frame-ancestors.)
 * - nosniff / Referrer-Policy / Permissions-Policy — standard hardening.
 * - HSTS only in production (the sandbox serves plain HTTP).
 */
const FRAME_ANCESTORS = "'self' https://web.telegram.org https://*.telegram.org"

function securityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': `frame-ancestors ${FRAME_ANCESTORS};`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  }
  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  }
  return headers
}

const nextConfig: NextConfig = {
  output: 'standalone',
  // Production builds must FAIL on type errors — no exceptions.
  // (was: ignoreBuildErrors: true — removed in Phase 1a per quality gate)
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: Object.entries(securityHeaders()).map(([key, value]) => ({ key, value })),
      },
    ]
  },
}

export default nextConfig
