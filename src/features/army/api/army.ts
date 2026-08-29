/**
 * WARLORDS — Army feature: army state, unit catalog queries and the recruit /
 * complete / cancel mutations.
 *
 * The ONLY way UI code touches the army endpoints — no raw fetch in
 * components (feature-boundary rule). Mutations stay thin: the server owns
 * every cost, duration, gate and queue decision. Successful mutations
 * invalidate the army, city, wallet, ledger and profile queries so every
 * surface reflects the real server state immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  ArmyCatalogView,
  ArmyView,
  RecruitResult,
  TrainingCancelResult,
  TrainingCompleteResult,
} from '../types'
import { economyKeys } from '@/features/economy/api/economy'
import { cityKeys } from '@/features/city/api/city'

export const armyKeys = {
  army: ['army', 'state'] as const,
  catalog: ['army', 'catalog'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { missing?: string[] } }
}

async function fetchArmyData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(new Error(body.error?.message ?? body.error?.code ?? 'ARMY_ENDPOINT_ERROR'), {
    code: body.error?.code,
    message: body.error?.message,
    details: body.error?.details,
  })
}

async function postArmyData<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw Object.assign(new Error(body.error?.message ?? body.error?.code ?? 'ARMY_MUTATION_ERROR'), {
    code: body.error?.code,
    details: body.error?.details,
  })
}

export function useArmyQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: armyKeys.army,
    queryFn: () => fetchArmyData<ArmyView>('/api/v1/army'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
    // While a training batch is in flight, poll lightly so the countdown can
    // flip to COMPLETABLE (READY) without a manual reload; idle armies stop
    // polling entirely.
    refetchInterval: (query) => ((query.state.data?.training.activeCount ?? 0) > 0 ? 3_000 : false),
  })
}

export function useArmyCatalogQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: armyKeys.catalog,
    queryFn: () => fetchArmyData<ArmyCatalogView>('/api/v1/army/catalog'),
    retry: false,
    staleTime: 60_000, // static config projection — cache generously
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** Invalidates every surface a training action touches (cost, queue, power, ledger). */
function useInvalidateArmySurfaces() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: armyKeys.army })
    void queryClient.invalidateQueries({ queryKey: cityKeys.city })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    void queryClient.invalidateQueries({ queryKey: economyKeys.transactions(8) })
    // Prefix invalidation — every ['player', …] query (profile carries power).
    void queryClient.invalidateQueries({ queryKey: ['player'] })
  }
}

export interface ArmyMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: { missing?: string[] } }) | null
}

export function useRecruitMutation() {
  const invalidate = useInvalidateArmySurfaces()
  return useMutation({
    mutationFn: (input: { unitId: string; count: number }) =>
      postArmyData<RecruitResult>('/api/v1/army/train', {
        unitId: input.unitId,
        count: input.count,
      }),
    onSuccess: invalidate,
  })
}

export function useCompleteTrainingMutation() {
  const invalidate = useInvalidateArmySurfaces()
  return useMutation({
    mutationFn: (itemId: string) =>
      postArmyData<TrainingCompleteResult>(`/api/v1/army/train/${itemId}/complete`),
    onSuccess: invalidate,
  })
}

export function useCancelTrainingMutation() {
  const invalidate = useInvalidateArmySurfaces()
  return useMutation({
    mutationFn: (itemId: string) =>
      postArmyData<TrainingCancelResult>(`/api/v1/army/train/${itemId}/cancel`),
    onSuccess: invalidate,
  })
}
