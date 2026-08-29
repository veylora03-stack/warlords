import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Production builds must FAIL on type errors — no exceptions.
  // (was: ignoreBuildErrors: true — removed in Phase 1a per quality gate)
  reactStrictMode: true,
}

export default nextConfig
