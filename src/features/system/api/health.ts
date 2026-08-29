/**
 * WARLORDS — System feature: health query hooks (TanStack Query).
 * The ONLY way UI code touches /api/health — no raw fetch in components.
 */

import { useQuery } from '@tanstack/react-query'
import type { HealthData } from '../types'
import type { ApiEnvelope } from '@/types/api'

export const healthKeys = {
  all: ['system', 'health'] as const,
}

async function fetchHealth(): Promise<HealthData> {
  const res = await fetch('/api/health', { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<HealthData>
  if (!body.ok) {
    throw new Error(`Health endpoint error: ${body.error.code}`)
  }
  return body.data
}

/**
 * Polls the health probe. Pass `enabled=false` to pause (user-controlled
 * auto-refresh lives in the UI store).
 */
export function useHealthQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: healthKeys.all,
    queryFn: fetchHealth,
    refetchInterval: options?.enabled === false ? false : 15_000,
  })
}
