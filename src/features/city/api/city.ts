/**
 * WARLORDS — City feature: city state + catalog queries and the upgrade /
 * finish construction mutations.
 *
 * The ONLY way UI code touches the city endpoints — no raw fetch in
 * components (feature-boundary rule). Mutations are the console's first
 * client-write surface and remain thin: the server owns every amount,
 * requirement and timer decision. Successful mutations invalidate the city,
 * wallet, ledger and profile queries so every surface reflects the real
 * server state immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  BuildingCatalogView,
  BuildingFinishResult,
  BuildingUpgradeResult,
  CityView,
} from '../types'
import { economyKeys } from '@/features/economy/api/economy'

export const cityKeys = {
  city: ['city', 'state'] as const,
  catalog: ['city', 'catalog'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { missing?: string[] } }
}

async function fetchCityData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(new Error(body.error?.code ?? 'CITY_ENDPOINT_ERROR'), {
    code: body.error?.code,
    message: body.error?.message,
    details: body.error?.details,
  })
}

async function postCityData<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST', cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw Object.assign(new Error(body.error?.message ?? body.error?.code ?? 'CITY_MUTATION_ERROR'), {
    code: body.error?.code,
    details: body.error?.details,
  })
}

export function useCityQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: cityKeys.city,
    queryFn: () => fetchCityData<CityView>('/api/v1/city'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
    // While a construction is in flight, poll lightly so the countdown can
    // flip to COMPLETABLE (READY) without a manual reload; idle cities stop
    // polling entirely.
    refetchInterval: (query) =>
      (query.state.data?.construction.activeCount ?? 0) > 0 ? 3_000 : false,
  })
}

export function useBuildingCatalogQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: cityKeys.catalog,
    queryFn: () => fetchCityData<BuildingCatalogView>('/api/v1/city/buildings'),
    retry: false,
    staleTime: 60_000, // static config projection — cache generously
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** Invalidates every surface an upgrade touches (cost, timers, power, ledger). */
function useInvalidateCitySurfaces() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: cityKeys.city })
    void queryClient.invalidateQueries({ queryKey: economyKeys.resources })
    void queryClient.invalidateQueries({ queryKey: economyKeys.transactions(8) })
    // Prefix invalidation — every ['player', …] query (profile carries power).
    void queryClient.invalidateQueries({ queryKey: ['player'] })
  }
}

export interface CityMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: { missing?: string[] } }) | null
  succeedAt: number | null
}

export function useUpgradeBuildingMutation() {
  const invalidate = useInvalidateCitySurfaces()
  return useMutation({
    mutationFn: (type: string) =>
      postCityData<BuildingUpgradeResult>(`/api/v1/city/buildings/${type}/upgrade`),
    onSuccess: invalidate,
  })
}

export function useFinishBuildingMutation() {
  const invalidate = useInvalidateCitySurfaces()
  return useMutation({
    mutationFn: (type: string) =>
      postCityData<BuildingFinishResult>(`/api/v1/city/buildings/${type}/finish`),
    onSuccess: invalidate,
  })
}
