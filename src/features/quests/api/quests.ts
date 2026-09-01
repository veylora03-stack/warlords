/**
 * WARLORDS — Quest feature: board, achievements and the claim mutation.
 *
 * The ONLY way UI code touches the quest endpoints — no raw fetch in
 * components (feature-boundary rule). The claim mutation stays thin: the
 * server owns every status transition, eligibility check and reward amount
 * (the DB's guarded status flip is the exactly-once arbiter; duplicate or
 * stale claims come back as typed 409s). Successful claims invalidate the
 * quest board + achievements, the wallet, the ledger and the profile
 * (claim pays XP/HONOR → level and power can move) so every surface
 * reflects the real server state immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type { AchievementBoardView, QuestBoardView, QuestClaimResult, QuestFilter } from '../types'
import { economyKeys } from '@/features/economy/api/economy'

export const questsKeys = {
  board: (filter: QuestFilter) => ['quests', 'board', filter] as const,
  achievements: ['quests', 'achievements'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

async function fetchQuestData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'QUEST_ENDPOINT_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

async function postQuestData<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST', cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'QUEST_MUTATION_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

export function useQuests(options?: { enabled?: boolean; filter?: QuestFilter }) {
  const filter = options?.filter ?? 'all'
  return useQuery({
    queryKey: questsKeys.board(filter),
    queryFn: () => fetchQuestData<QuestBoardView>(`/api/v1/quests?filter=${filter}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function useAchievements(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: questsKeys.achievements,
    queryFn: () => fetchQuestData<AchievementBoardView>('/api/v1/quests/achievements'),
    retry: false,
    staleTime: 15_000, // unlocks arrive via game transactions — cache briefly
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** Invalidates every surface a claim touches (board, wallet, ledger, profile). */
function useInvalidateQuestSurfaces() {
  const queryClient = useQueryClient()
  return () => {
    // Prefix invalidation — the board under every filter AND the achievements.
    void queryClient.invalidateQueries({ queryKey: ['quests'] })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    void queryClient.invalidateQueries({ queryKey: economyKeys.transactions(8) })
    // Prefix invalidation — every ['player', …] query (claim pays XP → level).
    void queryClient.invalidateQueries({ queryKey: ['player'] })
  }
}

export interface QuestMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: Record<string, unknown> }) | null
}

export function useClaimQuest() {
  const invalidate = useInvalidateQuestSurfaces()
  return useMutation({
    mutationFn: (questId: string) =>
      postQuestData<QuestClaimResult>(`/api/v1/quests/${questId}/claim`),
    onSuccess: invalidate,
  })
}
