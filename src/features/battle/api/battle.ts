/**
 * WARLORDS — Battle feature: targets, history, detail queries and the attack
 * mutation.
 *
 * The ONLY way UI code touches the battle endpoints — no raw fetch in
 * components (feature-boundary rule). The attack mutation stays thin: the
 * server owns every army, casualty, reward and cooldown decision. A client
 * idempotency key (crypto.randomUUID) makes a double-click replay the first
 * battle instead of creating a second one. Successful attacks invalidate
 * every surface a battle touches (wallet, ledger, player, army, season,
 * battles).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  AttackResultView,
  BattleDetailView,
  BattleHistoryView,
  BattleTargetsView,
} from '../types'
import { economyKeys } from '@/features/economy/api/economy'
import { cityKeys } from '@/features/city/api/city'
import { armyKeys } from '@/features/army/api/army'

export const battleKeys = {
  targets: ['battles', 'targets'] as const,
  history: (pageSize: number) => ['battles', 'history', pageSize] as const,
  detail: (battleId: string) => ['battles', 'detail', battleId] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

async function fetchBattleData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'BATTLE_ENDPOINT_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

async function postBattleData<T>(path: string, payload?: unknown): Promise<T> {
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
    new Error(body.error?.message ?? body.error?.code ?? 'BATTLE_MUTATION_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

export function useBattleTargetsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: battleKeys.targets,
    queryFn: () => fetchBattleData<BattleTargetsView>('/api/v1/battles/targets'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function useBattleHistoryQuery(options?: { enabled?: boolean; pageSize?: number }) {
  const pageSize = options?.pageSize ?? 8
  return useQuery({
    queryKey: battleKeys.history(pageSize),
    queryFn: () =>
      fetchBattleData<BattleHistoryView>(`/api/v1/battles?page=1&pageSize=${pageSize}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function useBattleDetailQuery(battleId: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: battleKeys.detail(battleId ?? ''),
    queryFn: () => fetchBattleData<BattleDetailView>(`/api/v1/battles/${battleId}`),
    retry: false,
    staleTime: 60_000, // battles are immutable history — cache generously
    refetchOnWindowFocus: false,
    enabled: Boolean(battleId) && (options?.enabled ?? true),
  })
}

/** Invalidates every surface a battle touches. */
function useInvalidateBattleSurfaces() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: battleKeys.targets })
    void queryClient.invalidateQueries({ queryKey: ['battles', 'history'] })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    void queryClient.invalidateQueries({ queryKey: economyKeys.transactions(8) })
    void queryClient.invalidateQueries({ queryKey: cityKeys.city })
    void queryClient.invalidateQueries({ queryKey: armyKeys.army })
    void queryClient.invalidateQueries({ queryKey: ['player'] })
    void queryClient.invalidateQueries({ queryKey: ['season'] })
  }
}

export interface BattleMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: Record<string, unknown> }) | null
}

export function useAttackMutation() {
  const invalidate = useInvalidateBattleSurfaces()
  return useMutation({
    mutationFn: (input: { targetPlayerId: string }) =>
      postBattleData<AttackResultView>('/api/v1/battles/attack', {
        targetPlayerId: input.targetPlayerId,
        // Server-side semantics: a replayed key returns the ORIGINAL battle.
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: invalidate,
  })
}
