/**
 * WARLORDS — Economy feature: wallet + ledger-history query hooks.
 *
 * The ONLY way UI code touches the economy endpoints — no raw fetch in
 * components (feature-boundary rule). Queries are enabled only while a
 * session exists; a 401 maps to `null` (anonymous state), never an error.
 * Both endpoints are read-only — the UI has no resource-mutation surface,
 * matching the server's deliberate GET-only economy API.
 */

import { useQuery } from '@tanstack/react-query'
import type { EconomyLedgerPage, EconomyWallet } from '../types'
import type { ApiEnvelope } from '@/types/api'

export const economyKeys = {
  resources: ['economy', 'resources'] as const,
  transactions: (limit: number) => ['economy', 'transactions', limit] as const,
}

async function fetchEconomyData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T>
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw new Error(`Economy endpoint error: ${body.error.code}`)
}

export function useResourcesQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: economyKeys.resources,
    queryFn: () => fetchEconomyData<EconomyWallet>('/api/v1/player/resources'),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

export function useTransactionsQuery(options?: { enabled?: boolean; limit?: number }) {
  const limit = options?.limit ?? 8
  return useQuery({
    queryKey: economyKeys.transactions(limit),
    queryFn: () =>
      fetchEconomyData<EconomyLedgerPage>(`/api/v1/player/transactions?limit=${limit}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}
