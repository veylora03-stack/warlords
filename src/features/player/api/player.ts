/**
 * WARLORDS — Player feature: profile / statistics / state query hooks.
 *
 * The ONLY way UI code touches the player endpoints — no raw fetch in
 * components (feature-boundary rule). Queries are enabled only while a
 * session exists; a 401 maps to `null` (anonymous state), never an error.
 */

import { useQuery } from '@tanstack/react-query'
import type { PlayerProfile, PlayerState, PlayerStatistics } from '../types'
import type { ApiEnvelope } from '@/types/api'

export const playerKeys = {
  profile: ['player', 'profile'] as const,
  statistics: ['player', 'statistics'] as const,
  state: ['player', 'state'] as const,
}

async function fetchPlayerData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T>
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw new Error(`Player endpoint error: ${body.error.code}`)
}

export function usePlayerProfileQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: playerKeys.profile,
    queryFn: () => fetchPlayerData<PlayerProfile>('/api/v1/player/profile'),
    retry: false,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function usePlayerStatisticsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: playerKeys.statistics,
    queryFn: () => fetchPlayerData<PlayerStatistics>('/api/v1/player/statistics'),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function usePlayerStateQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: playerKeys.state,
    queryFn: () => fetchPlayerData<PlayerState>('/api/v1/player/state'),
    retry: false,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}
