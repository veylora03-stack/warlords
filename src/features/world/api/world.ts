/**
 * WARLORDS — World Map feature: map viewport, territory detail/history,
 * holdings and the assault/collect mutations.
 *
 * The ONLY way UI code touches the world endpoints — no raw fetch in
 * components (feature-boundary rule). Every rule that matters (adjacency,
 * season gates, terrain, garrisons, casualties, capture, production accrual)
 * is server-authoritative; the client only picks a viewport and a target.
 * The attack mutation carries a client-generated idempotency key so double
 * taps replay the first response instead of fighting twice. Successful
 * mutations invalidate every surface they touch: the world cache (map +
 * detail + history + holdings), quests (CAPTURE/CONTROL objectives), the
 * wallet (spoils + production) and the profile (XP/honor → level & power).
 * Phase 34 adds the positional garrison surface: the lazy garrison view,
 * the DEFEND/REINFORCE deploy (a thin front of the ONE march engine — the
 * response IS a MarchView, with march-launch idempotency semantics) and the
 * per-contribution withdraw.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  PlayerTerritoriesView,
  TerritoryAttackResult,
  TerritoryCollectResult,
  TerritoryDetailView,
  TerritoryGarrisonView,
  TerritoryHistoryView,
  WorldBounds,
  WorldMapView,
} from '../types'
import { economyKeys } from '@/features/economy/api/economy'
import type { MarchView, WithdrawGarrisonResult } from '@/features/marches'

export const worldKeys = {
  map: (bounds: WorldBounds | null) => ['world', 'map', bounds] as const,
  detail: (territoryId: string | null) => ['world', 'territory', territoryId] as const,
  history: (territoryId: string | null, page: number) =>
    ['world', 'history', territoryId, page] as const,
  playerTerritories: ['world', 'player-territories'] as const,
  garrison: (territoryId: string | null) => ['world', 'garrison', territoryId] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

async function fetchWorldData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'WORLD_ENDPOINT_ERROR'),
    { code: body.error?.code, details: body.error?.details },
  )
}

async function postWorldData<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const parsed = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (parsed.ok) return parsed.data
  throw Object.assign(
    new Error(parsed.error?.message ?? parsed.error?.code ?? 'WORLD_MUTATION_ERROR'),
    { code: parsed.error?.code, details: parsed.error?.details },
  )
}

function mapBoundsQuery(bounds: WorldBounds | null): string {
  if (!bounds) return '/api/v1/world/map'
  const params = new URLSearchParams({
    minX: String(bounds.minX),
    maxX: String(bounds.maxX),
    minY: String(bounds.minY),
    maxY: String(bounds.maxY),
  })
  return `/api/v1/world/map?${params.toString()}`
}

/** Viewport map — `bounds: null` lets the server pick a capital-centered view. */
export function useWorldMap(options?: { enabled?: boolean; bounds?: WorldBounds | null }) {
  const bounds = options?.bounds ?? null
  return useQuery({
    queryKey: worldKeys.map(bounds),
    queryFn: () => fetchWorldData<WorldMapView>(mapBoundsQuery(bounds)),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** Lazy territory detail — pass `territoryId: null` until a cell is selected. */
export function useTerritoryDetail(options: { enabled?: boolean; territoryId: string | null }) {
  const territoryId = options.territoryId
  return useQuery({
    queryKey: worldKeys.detail(territoryId),
    queryFn: () =>
      fetchWorldData<TerritoryDetailView>(`/api/v1/world/territories/${territoryId ?? ''}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: (options.enabled ?? true) && territoryId !== null,
  })
}

/** Lazy ownership history (paginated) — loaded only when the panel expands. */
export function useTerritoryHistory(options: {
  enabled?: boolean
  territoryId: string | null
  page?: number
}) {
  const territoryId = options.territoryId
  const page = options.page ?? 1
  return useQuery({
    queryKey: worldKeys.history(territoryId, page),
    queryFn: () =>
      fetchWorldData<TerritoryHistoryView>(
        `/api/v1/world/territories/${territoryId ?? ''}/history?page=${page}&pageSize=10`,
      ),
    retry: false,
    staleTime: 30_000, // append-only record — cache briefly
    refetchOnWindowFocus: false,
    enabled: (options.enabled ?? true) && territoryId !== null,
  })
}

/** The caller's holdings + per-territory production readiness. */
export function usePlayerTerritories(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: worldKeys.playerTerritories,
    queryFn: () => fetchWorldData<PlayerTerritoriesView>('/api/v1/world/player-territories'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** Invalidates every surface an assault or a collection touches. */
function useInvalidateWorldSurfaces(options?: { quests?: boolean; player?: boolean }) {
  const queryClient = useQueryClient()
  return () => {
    // Prefix invalidation — map viewports, territory details, history, holdings.
    void queryClient.invalidateQueries({ queryKey: ['world'] })
    if (options?.quests) {
      // Territory capture feeds CONQUEROR/LAND LORD/DEFENDER quest progress.
      void queryClient.invalidateQueries({ queryKey: ['quests'] })
    }
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    if (options?.player) {
      // Assaults pay XP/honor → level and power can move.
      void queryClient.invalidateQueries({ queryKey: ['player'] })
    }
  }
}

export interface WorldMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: Record<string, unknown> }) | null
}

/**
 * Invalidates the surfaces a garrison DEPLOY/WITHDRAW touches — deployment
 * IS a march (one engine), units are reserved at launch and restored at
 * homecoming, and the garrison view + holdings re-render from the world
 * cache. Quest/stats surfaces are left alone: garrisoning is not a capture.
 */
function useInvalidateMarchSurfaces() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['marches'] })
    void queryClient.invalidateQueries({ queryKey: ['world'] })
    void queryClient.invalidateQueries({ queryKey: worldKeys.playerTerritories })
    void queryClient.invalidateQueries({ queryKey: ['army'] })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
  }
}

/**
 * The assault. The idempotency key is generated per logical submission here —
 * a retry of the SAME mutate() call (TanStack re-invokes mutationFn with the
 * same variables) replays the stored server response instead of refighting.
 */
export function useAttackTerritory() {
  const invalidate = useInvalidateWorldSurfaces({ quests: true, player: true })
  return useMutation({
    mutationFn: (input: { territoryId: string; idempotencyKey: string }) =>
      postWorldData<TerritoryAttackResult>(
        `/api/v1/world/territories/${input.territoryId}/attack`,
        { idempotencyKey: input.idempotencyKey },
      ),
    onSuccess: invalidate,
  })
}

/** Collects accrued production from ONE owned territory (ledger-integrated). */
export function useCollectProduction() {
  const invalidate = useInvalidateWorldSurfaces({ quests: false, player: false })
  return useMutation({
    mutationFn: (territoryId: string) =>
      postWorldData<TerritoryCollectResult>(`/api/v1/world/territories/${territoryId}/collect`),
    onSuccess: invalidate,
  })
}

// ── Positional garrison (Phase 34) ───────────────────────────────────────────

/**
 * Lazy positional garrison view for the selected territory — strength,
 * capacity, contributor presence. Unit-level manifests are filtered
 * SERVER-side (owner + contributors only); the client renders what arrives.
 * Polls gently while the panel is open so arrivals/battles show up.
 */
export function useTerritoryGarrison(options: { enabled?: boolean; territoryId: string | null }) {
  const territoryId = options.territoryId
  return useQuery({
    queryKey: worldKeys.garrison(territoryId),
    queryFn: () =>
      fetchWorldData<TerritoryGarrisonView>(
        `/api/v1/world/territories/${territoryId ?? ''}/garrison`,
      ),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: (options.enabled ?? true) && territoryId !== null,
    refetchInterval: (query) => (query.state.data?.garrisoned ? 15_000 : false),
  })
}

/**
 * Deploys a positional detachment: DEFEND (own territory) or REINFORCE
 * (owner or same-clan owner). This is the THIN garrison front of the ONE
 * march engine (the server routes it through createMarch), so the response
 * is a MarchView and the idempotency key semantics match the march launch —
 * one key per logical submission; a retry of the SAME mutate() call replays
 * the stored response instead of marching twice.
 */
export function useDeployGarrison() {
  const invalidate = useInvalidateMarchSurfaces()
  return useMutation({
    mutationFn: (input: {
      territoryId: string
      type: 'DEFEND' | 'REINFORCE'
      units: Array<{ unitId: string; count: number }>
      idempotencyKey: string
    }) =>
      postWorldData<MarchView>(`/api/v1/world/territories/${input.territoryId}/garrison`, {
        type: input.type,
        units: input.units,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: invalidate,
  })
}

/**
 * Withdraws ONE stationed contribution (the marchId comes from the server's
 * contributors list). The server cross-checks the march against the
 * territory in the path — a mismatched pair is a typed 404, never a leak.
 */
export function useWithdrawTerritoryGarrison() {
  const invalidate = useInvalidateMarchSurfaces()
  return useMutation({
    mutationFn: (input: { territoryId: string; marchId: string }) =>
      postWorldData<WithdrawGarrisonResult>(
        `/api/v1/world/territories/${input.territoryId}/garrison/withdraw`,
        { marchId: input.marchId },
      ),
    onSuccess: invalidate,
  })
}
