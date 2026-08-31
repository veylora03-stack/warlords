/**
 * WARLORDS — Admin feature: the ONLY way UI code touches /api/v1/admin.
 *
 * A 403 here is a MEANINGFUL UI state (RBAC working as intended), so it is
 * surfaced as a typed error instead of being swallowed. Visibility of the
 * panel comes from /admin/me — enforcement never leaves the server.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  AdminAdjustResult,
  AdminAnnouncementList,
  AdminAnnouncementRow,
  AdminAuditList,
  AdminBanResult,
  AdminBattleDetail,
  AdminBattleList,
  AdminBroadcastResult,
  AdminClanDetail,
  AdminClanList,
  AdminContext,
  AdminDeactivateResult,
  AdminDisbandResult,
  AdminEconomyOverview,
  AdminEventList,
  AdminEventRow,
  AdminGrantResult,
  AdminPlayerDetails,
  AdminPlayerSearch,
  AdminStaffRow,
  AdminUnbanResult,
} from '../types'

export const adminKeys = {
  me: ['admin', 'me'] as const,
  players: (q: string, page: number) => ['admin', 'players', q, page] as const,
  playerDetails: (id: string) => ['admin', 'player', id] as const,
  battles: (page: number) => ['admin', 'battles', page] as const,
  battleDetail: (id: string) => ['admin', 'battle', id] as const,
  economy: ['admin', 'economy'] as const,
  events: (status: string, page: number) => ['admin', 'events', status, page] as const,
  clans: (q: string, page: number) => ['admin', 'clans', q, page] as const,
  clanDetail: (id: string) => ['admin', 'clan', id] as const,
  announcements: (page: number) => ['admin', 'announcements', page] as const,
  audit: (action: string, page: number) => ['admin', 'audit', action, page] as const,
  staff: ['admin', 'staff'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

function toError(body: ApiErrorBody, fallback: string): Error & { code?: string } {
  return Object.assign(new Error(body.error?.message ?? body.error?.code ?? fallback), {
    code: body.error?.code,
  })
}

async function fetchAdmin<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw toError(body, `ADMIN_ENDPOINT_ERROR_${res.status}`)
}

async function postAdmin<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw toError(body, 'ADMIN_MUTATION_ERROR')
}

// ── Introspection ────────────────────────────────────────────────────────────

export function useAdminMeQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: adminKeys.me,
    queryFn: async (): Promise<AdminContext> => {
      const res = await fetch('/api/v1/admin/me', { cache: 'no-store' })
      const body = (await res.json()) as ApiEnvelope<AdminContext>
      return body.ok ? body.data : { isStaff: false }
    },
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
}

// ── Players ──────────────────────────────────────────────────────────────────

export function useAdminPlayersQuery(q: string, page: number, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  const params = new URLSearchParams({ page: String(page), pageSize: '10' })
  if (q) params.set('q', q)
  return useQuery({
    queryKey: adminKeys.players(q, page),
    queryFn: () => fetchAdmin<AdminPlayerSearch>(`/api/v1/admin/players?${params.toString()}`),
    enabled,
    staleTime: 5_000,
  })
}

export function useAdminPlayerDetailsQuery(playerId: string | null) {
  return useQuery({
    queryKey: adminKeys.playerDetails(playerId ?? ''),
    queryFn: () => fetchAdmin<AdminPlayerDetails>(`/api/v1/admin/players/${playerId}`),
    enabled: Boolean(playerId),
  })
}

export function useAdminBanMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { playerId: string; reason: string; expiresAt?: string }) =>
      postAdmin<AdminBanResult>(`/api/v1/admin/players/${input.playerId}/ban`, {
        reason: input.reason,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminUnbanMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { playerId: string; note?: string }) =>
      postAdmin<AdminUnbanResult>(`/api/v1/admin/players/${input.playerId}/unban`, {
        ...(input.note ? { note: input.note } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminAdjustMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { playerId: string; resource: string; delta: number; note: string }) =>
      postAdmin<AdminAdjustResult>(`/api/v1/admin/players/${input.playerId}/resources`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

// ── Inspections ──────────────────────────────────────────────────────────────

export function useAdminBattlesQuery(page: number, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: adminKeys.battles(page),
    queryFn: () => fetchAdmin<AdminBattleList>(`/api/v1/admin/battles?page=${page}&pageSize=10`),
    enabled,
    staleTime: 10_000,
  })
}

export function useAdminBattleDetailQuery(battleId: string | null) {
  return useQuery({
    queryKey: adminKeys.battleDetail(battleId ?? ''),
    queryFn: () => fetchAdmin<AdminBattleDetail>(`/api/v1/admin/battles/${battleId}`),
    enabled: Boolean(battleId),
  })
}

export function useAdminEconomyQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: adminKeys.economy,
    queryFn: () => fetchAdmin<AdminEconomyOverview>('/api/v1/admin/economy'),
    enabled,
    staleTime: 15_000,
  })
}

// ── Events ───────────────────────────────────────────────────────────────────

export function useAdminEventsQuery(
  status: string,
  page: number,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options
  const params = new URLSearchParams({ page: String(page), pageSize: '10' })
  if (status) params.set('status', status)
  return useQuery({
    queryKey: adminKeys.events(status, page),
    queryFn: () => fetchAdmin<AdminEventList>(`/api/v1/admin/events?${params.toString()}`),
    enabled,
    staleTime: 10_000,
  })
}

export function useAdminEventCreateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      type: string
      title?: string
      body?: string
      endsAt: string
      targetPlayerId?: string
    }) => postAdmin<AdminEventRow>('/api/v1/admin/events', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminEventTransitionMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { eventId: string; action: 'finish' | 'cancel'; reason?: string }) =>
      postAdmin<AdminEventRow>(
        `/api/v1/admin/events/${input.eventId}/${input.action}`,
        input.reason ? { reason: input.reason } : undefined,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

// ── Clans ────────────────────────────────────────────────────────────────────

export function useAdminClansQuery(q: string, page: number, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  const params = new URLSearchParams({ page: String(page), pageSize: '10' })
  if (q) params.set('q', q)
  return useQuery({
    queryKey: adminKeys.clans(q, page),
    queryFn: () => fetchAdmin<AdminClanList>(`/api/v1/admin/clans?${params.toString()}`),
    enabled,
    staleTime: 10_000,
  })
}

export function useAdminClanDetailQuery(clanId: string | null) {
  return useQuery({
    queryKey: adminKeys.clanDetail(clanId ?? ''),
    queryFn: () => fetchAdmin<AdminClanDetail>(`/api/v1/admin/clans/${clanId}`),
    enabled: Boolean(clanId),
  })
}

export function useAdminDisbandMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { clanId: string; confirm: string; reason: string }) =>
      postAdmin<AdminDisbandResult>(`/api/v1/admin/clans/${input.clanId}/disband`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

// ── Announcements ────────────────────────────────────────────────────────────

export function useAdminAnnouncementsQuery(page: number, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: adminKeys.announcements(page),
    queryFn: () =>
      fetchAdmin<AdminAnnouncementList>(`/api/v1/admin/announcements?page=${page}&pageSize=10`),
    enabled,
    staleTime: 10_000,
  })
}

export function useAdminAnnouncementCreateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; body: string; audience?: string }) =>
      postAdmin<AdminAnnouncementRow>('/api/v1/admin/announcements', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminAnnouncementActiveMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { announcementId: string; isActive: boolean }) =>
      postAdmin<AdminAnnouncementRow>(
        `/api/v1/admin/announcements/${input.announcementId}/active`,
        { isActive: input.isActive },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminBroadcastMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (announcementId: string) =>
      postAdmin<AdminBroadcastResult>(`/api/v1/admin/announcements/${announcementId}/broadcast`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

// ── Audit + staff ────────────────────────────────────────────────────────────

export function useAdminAuditQuery(
  action: string,
  page: number,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options
  const params = new URLSearchParams({ page: String(page), pageSize: '12' })
  if (action) params.set('action', action)
  return useQuery({
    queryKey: adminKeys.audit(action, page),
    queryFn: () => fetchAdmin<AdminAuditList>(`/api/v1/admin/audit-logs?${params.toString()}`),
    enabled,
    staleTime: 5_000,
  })
}

export function useAdminStaffQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: adminKeys.staff,
    queryFn: () => fetchAdmin<{ rows: AdminStaffRow[] }>('/api/v1/admin/staff'),
    enabled,
    staleTime: 10_000,
  })
}

export function useAdminGrantMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { telegramId: string; role: 'ADMIN' | 'MODERATOR' }) =>
      postAdmin<AdminGrantResult>('/api/v1/admin/staff', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}

export function useAdminDeactivateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (adminUserId: string) =>
      postAdmin<AdminDeactivateResult>(`/api/v1/admin/staff/${adminUserId}/deactivate`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
  })
}
