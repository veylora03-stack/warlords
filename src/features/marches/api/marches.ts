/**
 * WARLORDS — March feature: march list/detail queries and the launch /
 * recall / progress-check mutations.
 *
 * The ONLY way UI code touches the march endpoints — no raw fetch in
 * components (feature-boundary rule). Every rule that matters (origin,
 * distance, travel time, adjacency, season gates, slots, energy, unit
 * reservation, arrival, battle outcome, homecoming) is server-authoritative;
 * the client only picks a destination, an action and unit stacks, and may ask
 * the server to check progress (an idempotent no-op unless the SERVER clock
 * says a leg is due — the client can never make a march arrive early).
 *
 * The launch mutation carries a client-generated idempotency key as part of
 * the mutation variables: one key per logical submission — a retry of the
 * SAME mutate() call replays the stored server response instead of marching
 * twice. Successful mutations invalidate every surface they touch: the march
 * cache, the world holdings (an arrival can change ownership), the wallet
 * (energy is spent at launch) and the army (units are reserved/released).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import { economyKeys } from '@/features/economy/api/economy'
import { worldKeys } from '@/features/world/api/world'
import type {
  CancelMarchResult,
  CreateMarchInput,
  MarchListView,
  MarchView,
  ProcessMarchResult,
  WithdrawGarrisonResult,
} from '../types'

export const marchKeys = {
  list: ['marches', 'list'] as const,
  detail: (id: string | null) => ['marches', 'detail', id] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

async function fetchMarchData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'MARCH_ENDPOINT_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

async function postMarchData<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const parsed = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (parsed.ok) return parsed.data
  throw Object.assign(
    new Error(parsed.error?.message ?? parsed.error?.code ?? 'MARCH_MUTATION_ERROR'),
    { code: parsed.error?.code, details: parsed.error?.details },
  )
}

/** Is a march still in flight (the server's ACTIVE_MARCH_STATUSES)? */
function isMarchInFlight(march: Pick<MarchView, 'status'> | undefined | null): boolean {
  return (
    march?.status === 'EN_ROUTE' || march?.status === 'RESOLVING' || march?.status === 'RETURNING'
  )
}

/**
 * The caller's marches, freshest-first. Polls every 5s while ANY march is in
 * flight (derived from the server's own activeCount), else every 15s — the
 * list endpoint processes due marches lazily before responding, so polling is
 * also what advances rows.
 */
export function useMarches(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: marchKeys.list,
    queryFn: () => fetchMarchData<MarchListView>('/api/v1/marches'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
    refetchInterval: (query) => ((query.state.data?.activeCount ?? 0) > 0 ? 5_000 : 15_000),
  })
}

/** One march's server-authoritative state (owner-only; foreign id → 404). */
export function useMarch(options: { enabled?: boolean; id: string | null }) {
  const id = options.id
  return useQuery({
    queryKey: marchKeys.detail(id),
    queryFn: () => fetchMarchData<MarchView>(`/api/v1/marches/${id ?? ''}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: (options.enabled ?? true) && id !== null,
    refetchInterval: (query) => (isMarchInFlight(query.state.data) ? 5_000 : 15_000),
  })
}

/** Invalidates the surfaces a launch or recall touches. */
function useInvalidateMarchSurfaces() {
  const queryClient = useQueryClient()
  return () => {
    // Prefix invalidation — list + every cached detail.
    void queryClient.invalidateQueries({ queryKey: ['marches'] })
    // Units are reserved at launch and released on recall; holdings never
    // change here, but the server recomputes readiness per territory.
    void queryClient.invalidateQueries({ queryKey: worldKeys.playerTerritories })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    void queryClient.invalidateQueries({ queryKey: ['army'] })
  }
}

export interface MarchMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: Record<string, unknown> }) | null
}

/**
 * Launches a march. The idempotency key is generated per logical submission
 * by the caller and carried in the variables — a retry of the SAME mutate()
 * call replays the stored server response instead of marching twice.
 */
export function useCreateMarch() {
  const invalidate = useInvalidateMarchSurfaces()
  return useMutation({
    mutationFn: (input: CreateMarchInput) =>
      postMarchData<MarchView>('/api/v1/marches', {
        territoryId: input.territoryId,
        type: input.type,
        units: input.units,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    onSuccess: invalidate,
  })
}

/** Recalls a march that is still EN_ROUTE (server verdict: `cancellable`). */
export function useCancelMarch() {
  const invalidate = useInvalidateMarchSurfaces()
  return useMutation({
    mutationFn: (marchId: string) =>
      postMarchData<CancelMarchResult>(`/api/v1/marches/${marchId}/cancel`),
    onSuccess: invalidate,
  })
}

/**
 * Server-authoritative progress check (POST process). Safe to call at will —
 * an idempotent no-op unless the SERVER clock says a leg is due. An arrival
 * can change world ownership, so the world surfaces are invalidated too.
 */
export function useProcessMarch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (marchId: string) =>
      postMarchData<ProcessMarchResult>(`/api/v1/marches/${marchId}/process`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['marches'] })
      // An arrival resolves a battle and can capture the destination.
      void queryClient.invalidateQueries({ queryKey: ['world'] })
    },
  })
}

/**
 * Withdraws a STATIONED positional detachment (status ARRIVED) — the march
 * claim ARRIVED → RETURNING rides the one engine; survivors keep their
 * post-battle manifest and rejoin the army at homecoming. Invalidates the
 * march surfaces plus the world cache (the territory's garrison view and
 * holdings re-render from it) and the army (restoration at homecoming).
 */
export function useWithdrawMarch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (marchId: string) =>
      postMarchData<WithdrawGarrisonResult>(`/api/v1/marches/${marchId}/withdraw`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['marches'] })
      void queryClient.invalidateQueries({ queryKey: ['world'] })
      void queryClient.invalidateQueries({ queryKey: worldKeys.playerTerritories })
      void queryClient.invalidateQueries({ queryKey: ['army'] })
    },
  })
}
