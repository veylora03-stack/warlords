/**
 * WARLORDS — Clan feature types (mirror of the server DTOs).
 *
 * These mirror src/lib/game/services/clan.service.ts read models exactly
 * (ClanMemberView, ClanSummaryView, ClanDetailView, ClanInvitationView,
 * ClanListPage and the mutation results); nothing here is authoritative —
 * membership, roles and authorization are resolved from the database inside
 * the server's mutating transaction and arrive read-only through the REST
 * envelope. Power crosses as a string (BigInt policy); counters are JSON
 * numbers.
 */

export type ClanRole = 'LEADER' | 'OFFICER' | 'MEMBER'
export type ClanJoinPolicy = 'OPEN' | 'INVITE_ONLY'

export interface ClanMemberView {
  playerId: string
  name: string
  role: ClanRole
  /** BigInt policy — string, display only. */
  power: string
  level: number
  joinedAt: string
}

export interface ClanSummaryView {
  id: string
  name: string
  tag: string
  description: string | null
  leaderPlayerId: string
  leaderName: string
  memberCount: number
  maxMembers: number
  joinPolicy: ClanJoinPolicy
  trophies: number
  createdAt: string
}

export interface ClanDetailView extends ClanSummaryView {
  members: ClanMemberView[]
  /** The CALLER's role in this clan (null for outsiders). */
  viewerRole: ClanRole | null
  pendingInvitationCount: number
}

export interface ClanInvitationView {
  id: string
  clanId: string
  clanName: string
  clanTag: string
  invitorName: string
  createdAt: string
  expiresAt: string
}

export interface ClanListPage {
  clans: ClanSummaryView[]
  page: number
  pageSize: number
  total: number
}

/** POST /api/v1/clans body — everything else is server-derived. */
export interface CreateClanInput {
  name: string
  tag: string
  description?: string
  joinPolicy?: ClanJoinPolicy
}

/** POST /api/v1/clans/[id]/join body — INVITE_ONLY clans claim an invitation. */
export interface JoinClanInput {
  invitationId?: string
}

/** POST /api/v1/clans/[id]/invite body — the server requires a player id. */
export interface InviteMemberInput {
  playerId: string
}

/** POST /api/v1/clans/[id]/members/[playerId]/role body. */
export interface SetMemberRoleInput {
  role: Extract<ClanRole, 'OFFICER' | 'MEMBER'>
}

export interface LeaveClanResult {
  leftClanId: string
}

export interface SetMemberRoleResult {
  playerId: string
  role: 'OFFICER' | 'MEMBER'
}

export interface RemoveMemberResult {
  removedPlayerId: string
}

/**
 * Client-side length hints for the create form — mirrors
 * src/lib/game/config/clan.ts (the server re-validates and stays the ONLY
 * authority; these constants only shape inputs and hints).
 */
export const CLAN_FORM_LIMITS = {
  nameMin: 3,
  nameMax: 24,
  tagMin: 2,
  tagMax: 5,
  descriptionMax: 200,
} as const
