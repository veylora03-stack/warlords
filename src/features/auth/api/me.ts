/**
 * WARLORDS — Auth feature: session query hook (TanStack Query).
 * The ONLY way UI code touches /api/v1/auth/me — no raw fetch in components.
 * A missing session (401) is a normal UI state → `null`, not an error.
 */

import { useQuery } from '@tanstack/react-query'
import type { MeData } from '../types'
import type { ApiEnvelope } from '@/types/api'

export const authKeys = {
  me: ['auth', 'me'] as const,
}

async function fetchMe(): Promise<MeData | null> {
  const res = await fetch('/api/v1/auth/me', { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<MeData>
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw new Error(`Auth endpoint error: ${body.error.code}`)
}

export function useMeQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: fetchMe,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}
