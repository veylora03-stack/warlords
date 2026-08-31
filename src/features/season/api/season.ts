/**
 * WARLORDS — Season feature: season status, ranking, rewards, progression.
 *
 * The ONLY way UI code touches the season endpoints — no raw fetch in
 * components (feature-boundary rule). The client can never mutate season
 * state, scores or rankings; the only intents are the IDEMPOTENT reward
 * claim and the owned-title equip.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  ClaimSeasonRewardResult,
  SeasonProgressionView,
  SeasonRankingView,
  SeasonRewardsView,
  SeasonView,
} from '../types'
import { economyKeys } from '@/features/economy/api/economy'

export const seasonKeys = {
  season: ['season', 'state'] as const,
  ranking: ['season', 'ranking'] as const,
  rewards: ['season', 'rewards'] as const,
  progression: ['season', 'progression'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

async function fetchSeasonData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'SEASON_ENDPOINT_ERROR'),
    { code: body.error?.code, message: body.error?.message },
  )
}

async function postSeasonData<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'SEASON_MUTATION_ERROR'),
    { code: body.error?.code, message: body.error?.message },
  )
}

export function useSeasonQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: seasonKeys.season,
    queryFn: () => fetchSeasonData<SeasonView>('/api/v1/season'),
    enabled,
    refetchInterval: 15_000, // season clock ticks slowly — 15s keeps the countdown honest
  })
}

export function useSeasonRankingQuery(options: { enabled?: boolean; limit?: number } = {}) {
  const { enabled = true, limit = 10 } = options
  return useQuery({
    queryKey: [...seasonKeys.ranking, limit],
    queryFn: () => fetchSeasonData<SeasonRankingView>(`/api/v1/season/ranking?limit=${limit}`),
    enabled,
    refetchInterval: 15_000,
  })
}

export function useSeasonRewardsQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: seasonKeys.rewards,
    queryFn: () => fetchSeasonData<SeasonRewardsView>('/api/v1/season/rewards'),
    enabled,
  })
}

export function useSeasonProgressionQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: seasonKeys.progression,
    queryFn: () => fetchSeasonData<SeasonProgressionView>('/api/v1/season/progression'),
    enabled,
  })
}

/** Idempotent reward claim — replays return the original payout. */
export function useClaimSeasonRewardMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (seasonId: string) =>
      postSeasonData<ClaimSeasonRewardResult>('/api/v1/season/rewards/claim', { seasonId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: seasonKeys.rewards })
      void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
      void queryClient.invalidateQueries({ queryKey: ['economy', 'transactions'] })
    },
  })
}

/** Equip an OWNED title (or null to clear). */
export function useEquipTitleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (titleId: string | null) =>
      postSeasonData<{ equippedTitleId: string | null }>('/api/v1/season/progression/title', {
        titleId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: seasonKeys.progression })
    },
  })
}
