/**
 * WARLORDS — Clan feature: my-clan / roster / directory / invitations queries
 * and the membership mutations.
 *
 * The ONLY way UI code touches the clan endpoints — no raw fetch in
 * components (feature-boundary rule). Every rule that matters (uniqueness,
 * capacity, role matrix, succession, join policy, invitation validity) is
 * server-authoritative: mutations carry NO idempotency key because the clan
 * routes don't accept one — replays are arbitrated by SERVER STATE and land
 * on typed 409s (ALREADY_IN_CLAN / CLAN_FULL / CLAN_INVITATION_INVALID …),
 * never on double writes. Successful mutations invalidate the clan cache and
 * the player profile (Player.clanId/clanRole are denormalized mirrors).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type {
  ClanDetailView,
  ClanInvitationView,
  ClanListPage,
  CreateClanInput,
  InviteMemberInput,
  JoinClanInput,
  LeaveClanResult,
  RemoveMemberResult,
  SetMemberRoleInput,
  SetMemberRoleResult,
} from '../types'

export const clanKeys = {
  my: ['clans', 'my'] as const,
  detail: (clanId: string | null) => ['clans', 'detail', clanId] as const,
  list: (page: number) => ['clans', 'list', page] as const,
  invitations: ['clans', 'invitations'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

async function fetchClanData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(new Error(body.error?.message ?? body.error?.code ?? 'CLAN_ENDPOINT_ERROR'), {
    code: body.error?.code,
    details: body.error?.details,
  })
}

async function postClanData<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const parsed = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (parsed.ok) return parsed.data
  throw Object.assign(
    new Error(parsed.error?.message ?? parsed.error?.code ?? 'CLAN_MUTATION_ERROR'),
    { code: parsed.error?.code, details: parsed.error?.details },
  )
}

/** Paginated clan directory (largest first — server ordering). */
export function useClanList(options?: { enabled?: boolean; page?: number }) {
  const page = options?.page ?? 1
  return useQuery({
    queryKey: clanKeys.list(page),
    queryFn: () => fetchClanData<ClanListPage>(`/api/v1/clans?page=${page}&pageSize=10`),
    retry: false,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
  })
}

/** One clan's detail (roster included) — public to authenticated players. */
export function useClanDetail(options: { enabled?: boolean; clanId: string | null }) {
  const clanId = options.clanId
  return useQuery({
    queryKey: clanKeys.detail(clanId),
    queryFn: () => fetchClanData<ClanDetailView>(`/api/v1/clans/${clanId ?? ''}`),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    enabled: (options.enabled ?? true) && clanId !== null,
  })
}

/**
 * The caller's live clan invitations (PENDING, unexpired) — polled gently;
 * invitations expire server-side after 24h (config policy).
 */
export function useMyInvitations(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: clanKeys.invitations,
    queryFn: () =>
      fetchClanData<{ invitations: ClanInvitationView[] }>('/api/v1/clans/invitations'),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    enabled: options?.enabled,
    refetchInterval: 30_000,
  })
}

/** Invalidates every surface a clan mutation touches. */
function useInvalidateClanSurfaces() {
  const queryClient = useQueryClient()
  return () => {
    // Prefix invalidation — my detail, directory pages, invitations.
    void queryClient.invalidateQueries({ queryKey: ['clans'] })
    // Player.clanId/clanRole are denormalized server-side mirrors.
    void queryClient.invalidateQueries({ queryKey: ['player'] })
  }
}

export interface ClanMutationState {
  isPending: boolean
  error: (Error & { code?: string; details?: Record<string, unknown> }) | null
}

/** Founds a clan (caller becomes LEADER). Refusals: typed 409s. */
export function useCreateClan() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: CreateClanInput) =>
      postClanData<ClanDetailView>('/api/v1/clans', {
        name: input.name,
        tag: input.tag,
        ...(input.description !== undefined && input.description !== ''
          ? { description: input.description }
          : {}),
      }),
    onSuccess: invalidate,
  })
}

/** Joins a clan (OPEN directly; INVITE_ONLY claims a PENDING invitation). */
export function useJoinClan() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: { clanId: string } & JoinClanInput) =>
      postClanData<ClanDetailView>(`/api/v1/clans/${input.clanId}/join`, {
        ...(input.invitationId !== undefined ? { invitationId: input.invitationId } : {}),
      }),
    onSuccess: invalidate,
  })
}

/** Leaves the caller's clan (LEADER needs succession first — typed 409). */
export function useLeaveClan() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (clanId: string) => postClanData<LeaveClanResult>(`/api/v1/clans/${clanId}/leave`),
    onSuccess: invalidate,
  })
}

/** Invites a player (OFFICER+; the server requires the target's player id). */
export function useInviteMember() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: { clanId: string } & InviteMemberInput) =>
      postClanData<ClanInvitationView>(`/api/v1/clans/${input.clanId}/invite`, {
        playerId: input.playerId,
      }),
    onSuccess: invalidate,
  })
}

/** Promotes/demotes MEMBER ↔ OFFICER (LEADER only). */
export function useSetMemberRole() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: { clanId: string; playerId: string } & SetMemberRoleInput) =>
      postClanData<SetMemberRoleResult>(
        `/api/v1/clans/${input.clanId}/members/${input.playerId}/role`,
        { role: input.role },
      ),
    onSuccess: invalidate,
  })
}

/** Removes a MEMBER (OFFICER+; rank matrix enforced server-side). */
export function useRemoveMember() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: { clanId: string; playerId: string }) =>
      postClanData<RemoveMemberResult>(
        `/api/v1/clans/${input.clanId}/members/${input.playerId}/remove`,
      ),
    onSuccess: invalidate,
  })
}

/** Transfers leadership to a member (LEADER only; old leader → OFFICER). */
export function useTransferLeadership() {
  const invalidate = useInvalidateClanSurfaces()
  return useMutation({
    mutationFn: (input: { clanId: string; playerId: string }) =>
      postClanData<ClanDetailView>(`/api/v1/clans/${input.clanId}/transfer`, {
        playerId: input.playerId,
      }),
    onSuccess: invalidate,
  })
}
