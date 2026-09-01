/**
 * WARLORDS — Admin panel configuration (Phase 21: RBAC + safety rails).
 *
 * EVERY authorization decision for the admin surface resolves HERE and only
 * here: the scope catalog, the per-role scope matrix and the destructive-op
 * confirmation phrases. Routes never hard-code role names — they declare a
 * SCOPE and `requireAdminScope` resolves it through this matrix against the
 * caller's DB-backed AdminUser row. A hidden frontend button protects
 * nothing; this file + the server-side guard are the entire security model.
 *
 * Role semantics (AdminUser.role):
 *   SUPERADMIN — legacy/platform-owner role (seeded from ADMIN_TELEGRAM_IDS);
 *                resolved with the full ADMIN scope set.
 *   ADMIN      — full operations surface.
 *   MODERATOR  — player-facing ops only: search/inspect/ban/unban, read-only
 *                economy/battle/clan/event inspection, announcements, audit
 *                viewer. NO resource adjustments, NO event/clan mutations,
 *                NO staff management, NO season settlement.
 */

// ── Roles ────────────────────────────────────────────────────────────────────

export const ADMIN_ROLES = ['MODERATOR', 'ADMIN'] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

/** Every role value that may appear on an AdminUser row (incl. the legacy seed). */
export const ADMIN_ROLE_STORAGE_VALUES = ['MODERATOR', 'ADMIN', 'SUPERADMIN'] as const
export type AdminRoleStorageValue = (typeof ADMIN_ROLE_STORAGE_VALUES)[number]

/** The role a MODERATOR may be granted or demoted to by staff management. */
export const GRANTABLE_ADMIN_ROLES = ['ADMIN', 'MODERATOR'] as const

/** SUPERADMIN (legacy seed) resolves with the full ADMIN scope set. */
export function normalizeAdminRole(role: string): AdminRole {
  return role === 'MODERATOR' ? 'MODERATOR' : 'ADMIN'
}

// ── Scopes ───────────────────────────────────────────────────────────────────

export const ADMIN_SCOPES = [
  // Players & moderation
  'players.search',
  'players.view',
  'players.ban',
  'players.unban',
  'players.adjust_resources',
  // Inspections (read-only)
  'battles.view',
  'economy.view',
  // Events
  'events.view',
  'events.manage',
  // Clans
  'clans.view',
  'clans.manage',
  // Announcements
  'announcements.view',
  'announcements.create',
  'announcements.manage',
  // Governance
  'audit.view',
  'staff.manage',
  'season.settle',
  // Notifications ops (Phase 22)
  'notifications.drain',
  // Quests ops (Phase 31 — enable/disable, inspect, reset, grant/revoke)
  'quests.view',
  'quests.manage',
] as const

export type AdminScope = (typeof ADMIN_SCOPES)[number]

/**
 * The RBAC matrix — THE answer to "which role may do what".
 * MODERATOR must stay a strict subset of ADMIN (validated below + tests).
 */
export const ADMIN_ROLE_SCOPES: Record<AdminRole, readonly AdminScope[]> = {
  MODERATOR: [
    'players.search',
    'players.view',
    'players.ban',
    'players.unban',
    'battles.view',
    'economy.view',
    'events.view',
    'clans.view',
    'announcements.view',
    'announcements.create',
    'audit.view',
    'quests.view',
  ],
  ADMIN: ADMIN_SCOPES,
}

/** Server-side authorization resolver — the ONLY path from role to permission. */
export function adminRoleHasScope(role: string, scope: AdminScope): boolean {
  if (!(ADMIN_ROLE_STORAGE_VALUES as readonly string[]).includes(role)) return false
  return ADMIN_ROLE_SCOPES[normalizeAdminRole(role)].includes(scope)
}

/** Scope list for UI introspection (server-computed — /admin/me). */
export function adminScopesForRole(role: string): readonly AdminScope[] {
  if (!(ADMIN_ROLE_STORAGE_VALUES as readonly string[]).includes(role)) return []
  return ADMIN_ROLE_SCOPES[normalizeAdminRole(role)]
}

// ── Safety rails ─────────────────────────────────────────────────────────────

/**
 * Destructive operations demand a typed confirmation phrase in the body —
 * an operator cannot disband a clan with a stray click, and the phrase is
 * validated SERVER-side before the transaction runs.
 */
export const ADMIN_CONFIRMATIONS = {
  clanDisband: 'DISBAND',
  seasonSettle: 'RESET SEASON',
} as const

// ── Policy numbers (the only place they live) ───────────────────────────────

export const ADMIN_PANEL_POLICY = {
  /** Search/result page sizes. */
  pageSizeDefault: 20,
  pageSizeMax: 50,
  /** Ban reason minimum length (operator accountability). */
  banReasonMinLength: 4,
  banReasonMaxLength: 300,
  /** Resource adjustment note bounds (also enforced by the Phase 5 service). */
  adjustNoteMinLength: 4,
  adjustNoteMaxLength: 500,
  /** Ledger-tail rows inside player details. */
  ledgerTailRows: 12,
  battleTailRows: 6,
  /** Economy inspection flow window. */
  flowWindowDays: 30,
  /** Broadcast fan-out guard — refused above this many players without force. */
  broadcastHardCap: 100_000,
} as const

// ── Invariant validation (fail fast on matrix edits) ────────────────────────

/** Throws a list of problems; empty = the matrix is coherent. */
export function validateAdminRbac(): string[] {
  const problems: string[] = []

  const total = ADMIN_SCOPES.length
  if (new Set(ADMIN_SCOPES).size !== total) problems.push('duplicate scopes in ADMIN_SCOPES')

  for (const role of ADMIN_ROLES) {
    const scopes = ADMIN_ROLE_SCOPES[role]
    for (const scope of scopes) {
      if (!(ADMIN_SCOPES as readonly string[]).includes(scope)) {
        problems.push(`role ${role} references unknown scope ${scope}`)
      }
    }
    if (new Set(scopes).size !== scopes.length) {
      problems.push(`role ${role} has duplicate scopes`)
    }
  }

  // MODERATOR ⊆ ADMIN (strict hierarchy).
  const adminSet = new Set<string>(ADMIN_ROLE_SCOPES.ADMIN)
  for (const scope of ADMIN_ROLE_SCOPES.MODERATOR) {
    if (!adminSet.has(scope)) problems.push(`MODERATOR scope ${scope} is missing from ADMIN`)
  }

  // The contract-critical denials are structural, not accidental.
  const moderatorForbidden: AdminScope[] = [
    'players.adjust_resources',
    'events.manage',
    'clans.manage',
    'announcements.manage',
    'staff.manage',
    'season.settle',
  ]
  for (const scope of moderatorForbidden) {
    if (ADMIN_ROLE_SCOPES.MODERATOR.includes(scope)) {
      problems.push(`MODERATOR must NOT hold ${scope}`)
    }
  }

  return problems
}
