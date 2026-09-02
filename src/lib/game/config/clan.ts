/**
 * WARLORDS — Clan configuration (Phase 34: Clans & Positional Territory
 * Garrisons).
 *
 * The ONLY place clan policy numbers live (ARCHITECTURE.md rule). The clan
 * service reads this config; rebalancing never touches logic. Every rule is
 * SERVER-authoritative — membership, roles and authorization are resolved
 * from the database inside the mutating transaction (NEVER TRUST THE CLIENT).
 *
 * Roles reuse the Phase 2 contract vocabulary (CLAN_ROLES): LEADER > OFFICER
 * > MEMBER, with EXACTLY ONE LEADER per clan (Clan.leaderPlayerId is the
 * single source of truth; the ClanMember.role row mirrors it in-transaction).
 */

/** Role rank — higher outranks lower. Used for the management matrix. */
export const CLAN_ROLE_RANKS = { MEMBER: 1, OFFICER: 2, LEADER: 3 } as const
export type ClanRoleKey = keyof typeof CLAN_ROLE_RANKS

/** Join policies (Clan.settings.joinPolicy). */
export const CLAN_JOIN_POLICIES = ['OPEN', 'INVITE_ONLY'] as const
export type ClanJoinPolicy = (typeof CLAN_JOIN_POLICIES)[number]

/**
 * Clan policy configuration — versioned as a whole. Bump `version` whenever
 * ANY value below changes.
 */
export const CLAN = {
  /** Config snapshot version — bump whenever any policy below changes. */
  version: 1,

  /** Clan name bounds (display name, unique). */
  nameMinLength: 3,
  nameMaxLength: 24,
  /** Clan tag bounds (unique, uppercase [A-Z0-9]). */
  tagMinLength: 2,
  tagMaxLength: 5,

  /** Maximum simultaneous members per clan (Clan.memberCount is capped). */
  maxMembers: 50,

  /** Invitation lifetime in hours (ClanInvitation.expiresAt). */
  invitationTtlHours: 24,

  /** Join policies + default (OPEN allows direct joins, INVITE_ONLY
   *  requires a PENDING invitation claimed by the joiner). */
  joinPolicies: CLAN_JOIN_POLICIES,
  defaultJoinPolicy: 'OPEN' as ClanJoinPolicy,
} as const

export type ClanPolicy = typeof CLAN

/** Invariants — a broken config must fail fast at first import. */
;((): void => {
  const problems: string[] = []
  if (!Number.isInteger(CLAN.version) || CLAN.version < 1)
    problems.push('version must be a positive integer')
  if (CLAN.nameMinLength < 1 || CLAN.nameMaxLength < CLAN.nameMinLength)
    problems.push('clan name bounds invalid')
  if (CLAN.tagMinLength < 1 || CLAN.tagMaxLength < CLAN.tagMinLength)
    problems.push('clan tag bounds invalid')
  if (!Number.isInteger(CLAN.maxMembers) || CLAN.maxMembers < 2)
    problems.push('maxMembers must be an integer >= 2')
  if (!Number.isInteger(CLAN.invitationTtlHours) || CLAN.invitationTtlHours < 1)
    problems.push('invitationTtlHours must be an integer >= 1')
  if (!CLAN.joinPolicies.includes(CLAN.defaultJoinPolicy))
    problems.push('defaultJoinPolicy must be one of joinPolicies')
  if (problems.length > 0) throw new Error(`Invalid CLAN config: ${problems.join('; ')}`)
})()
