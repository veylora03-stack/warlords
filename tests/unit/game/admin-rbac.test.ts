/**
 * Unit tests — Admin RBAC config invariants (config/admin.ts).
 *
 * The matrix is the entire security model of the admin surface; these
 * invariants keep it honest: MODERATOR ⊂ ADMIN (strict), the moderator
 * FORBIDDEN set is structural (never accidentally granted), every role
 * reference resolves, and the resolver refuses unknown roles outright.
 */

import { describe, it, expect } from 'bun:test'
import {
  ADMIN_PANEL_POLICY,
  ADMIN_CONFIRMATIONS,
  ADMIN_ROLE_SCOPES,
  ADMIN_ROLES,
  ADMIN_SCOPES,
  GRANTABLE_ADMIN_ROLES,
  adminRoleHasScope,
  adminScopesForRole,
  normalizeAdminRole,
  validateAdminRbac,
} from '../../../src/lib/game/config/admin'

describe('admin RBAC matrix invariants', () => {
  it('passes the built-in validator', () => {
    expect(validateAdminRbac()).toEqual([])
  })

  it('every role-referenced scope exists in the canonical catalog', () => {
    const catalog = new Set<string>(ADMIN_SCOPES)
    for (const role of ADMIN_ROLES) {
      for (const scope of ADMIN_ROLE_SCOPES[role]) {
        expect(catalog.has(scope)).toBe(true)
      }
    }
  })

  it('MODERATOR is a strict subset of ADMIN', () => {
    const admin = new Set(ADMIN_ROLE_SCOPES.ADMIN)
    for (const scope of ADMIN_ROLE_SCOPES.MODERATOR) {
      expect(admin.has(scope)).toBe(true)
    }
    expect(ADMIN_ROLE_SCOPES.MODERATOR.length).toBeLessThan(ADMIN_ROLE_SCOPES.ADMIN.length)
  })

  it('moderator never holds the money/power scopes (structural)', () => {
    for (const scope of [
      'players.adjust_resources',
      'events.manage',
      'clans.manage',
      'announcements.manage',
      'staff.manage',
      'season.settle',
    ] as const) {
      expect(ADMIN_ROLE_SCOPES.MODERATOR).not.toContain(scope)
      expect(adminRoleHasScope('MODERATOR', scope)).toBe(false)
    }
  })

  it('moderator holds the moderation + inspection scopes (contract)', () => {
    for (const scope of [
      'players.search',
      'players.view',
      'players.ban',
      'players.unban',
      'battles.view',
      'economy.view',
      'audit.view',
      'announcements.create',
    ] as const) {
      expect(adminRoleHasScope('MODERATOR', scope)).toBe(true)
    }
  })

  it('admin holds every scope; legacy SUPERADMIN resolves identically', () => {
    for (const scope of ADMIN_SCOPES) {
      expect(adminRoleHasScope('ADMIN', scope)).toBe(true)
      expect(adminRoleHasScope('SUPERADMIN', scope)).toBe(true)
    }
    expect(normalizeAdminRole('SUPERADMIN')).toBe('ADMIN')
    expect(normalizeAdminRole('MODERATOR')).toBe('MODERATOR')
  })

  it('unknown roles are refused outright (fail-closed)', () => {
    expect(adminRoleHasScope('USER', 'players.search')).toBe(false)
    expect(adminRoleHasScope('', 'players.search')).toBe(false)
    expect(adminRoleHasScope('h4x0r', 'players.search')).toBe(false)
    expect(adminScopesForRole('USER')).toEqual([])
  })

  it('grantable roles are exactly the RBAC role set minus the legacy seed', () => {
    expect([...GRANTABLE_ADMIN_ROLES].sort()).toEqual(['ADMIN', 'MODERATOR'])
  })

  it('destructive operations demand typed confirmation phrases', () => {
    expect(ADMIN_CONFIRMATIONS.clanDisband).toBe('DISBAND')
    expect(ADMIN_CONFIRMATIONS.seasonSettle).toBe('RESET SEASON')
  })

  it('policy numbers are sane', () => {
    expect(ADMIN_PANEL_POLICY.pageSizeMax).toBeGreaterThanOrEqual(
      ADMIN_PANEL_POLICY.pageSizeDefault,
    )
    expect(ADMIN_PANEL_POLICY.banReasonMinLength).toBeGreaterThanOrEqual(1)
    expect(ADMIN_PANEL_POLICY.banReasonMaxLength).toBeGreaterThan(
      ADMIN_PANEL_POLICY.banReasonMinLength,
    )
    expect(ADMIN_PANEL_POLICY.ledgerTailRows).toBeGreaterThan(0)
    expect(ADMIN_PANEL_POLICY.broadcastHardCap).toBeGreaterThan(0)
  })
})
