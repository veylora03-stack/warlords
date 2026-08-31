/**
 * WARLORDS — Admin staff management service (Phase 21).
 *
 * The RBAC control plane: list staff, grant ADMIN/MODERATOR, deactivate.
 * ADMIN-only scope (staff.manage). Grants upsert the AdminUser row —
 * the DB row (NOT any client claim) is what requireAdminScope resolves on
 * every admin request, so a revoke takes effect on the staff member's very
 * next request.
 */

import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { GRANTABLE_ADMIN_ROLES, type AdminRoleStorageValue } from '@/lib/game/config/admin'
import { recordAdminAuditInTx, recordAdminAuditView } from './admin-audit.service'

export interface AdminStaffRow {
  adminUserId: string
  userId: string
  telegramId: string
  username: string | null
  userRole: string
  role: string
  isActive: boolean
  lastActionAt: string | null
  createdAt: string
}

export async function listStaff(input: {
  actorUserId: string
  ip?: string
}): Promise<AdminStaffRow[]> {
  const rows = await db.adminUser.findMany({
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { telegramId: true, username: true, role: true } } },
  })
  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_STAFF',
    targetType: 'staff',
    reason: `list → ${rows.length}`,
    ip: input.ip,
  })
  return rows.map((row) => ({
    adminUserId: row.id,
    userId: row.userId,
    telegramId: row.user.telegramId,
    username: row.user.username,
    userRole: row.user.role,
    role: row.role,
    isActive: row.isActive,
    lastActionAt: row.lastActionAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

export interface GrantStaffInput {
  actorUserId: string
  telegramId: string
  role: AdminRoleStorageValue
  ip?: string
}

export interface GrantStaffResult {
  adminUserId: string
  userId: string
  telegramId: string
  role: string
  isActive: true
}

/**
 * Grants (or re-roles) a staff member BY TELEGRAM ID — the operator names a
 * registered account; the server resolves the User row and upserts the
 * AdminUser authorization. The actor cannot demote or deactivate THEMSELF
 * through this path accidentally: role grants are idempotent upserts, and
 * self-deactivation is refused (an admin panel without admins is a lockout).
 */
export async function grantStaff(input: GrantStaffInput): Promise<GrantStaffResult> {
  if (!(GRANTABLE_ADMIN_ROLES as readonly string[]).includes(input.role)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Role must be one of ${GRANTABLE_ADMIN_ROLES.join(' | ')}`,
    )
  }
  const telegramId = input.telegramId.trim()
  if (!/^\d{1,20}$/.test(telegramId)) {
    throw new AppError('VALIDATION_ERROR', 'telegramId must be a numeric Telegram id')
  }

  return dbWrite.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { telegramId },
      select: {
        id: true,
        username: true,
        adminRecord: { select: { id: true, role: true, isActive: true } },
      },
    })
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'No registered user with that telegram id')
    }

    const existing = user.adminRecord
    if (existing) {
      if (existing.role === input.role && existing.isActive) {
        throw new AppError('VALIDATION_ERROR', 'User already holds that role (active)')
      }
      const updated = await tx.adminUser.update({
        where: { id: existing.id },
        data: { role: input.role, isActive: true },
      })
      await recordAdminAuditInTx(tx, {
        actorUserId: input.actorUserId,
        action: 'STAFF_ROLE_SET',
        targetType: 'staff',
        targetId: updated.id,
        before: { role: existing.role, isActive: existing.isActive },
        after: { role: updated.role, isActive: updated.isActive },
        reason: `telegramId ${telegramId}`,
        ip: input.ip,
      })
      return {
        adminUserId: updated.id,
        userId: user.id,
        telegramId,
        role: updated.role,
        isActive: true,
      }
    }

    const created = await tx.adminUser.create({
      data: { userId: user.id, role: input.role, isActive: true },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'STAFF_GRANT',
      targetType: 'staff',
      targetId: created.id,
      after: { userId: user.id, role: created.role },
      reason: `telegramId ${telegramId}`,
      ip: input.ip,
    })
    return {
      adminUserId: created.id,
      userId: user.id,
      telegramId,
      role: created.role,
      isActive: true,
    }
  })
}

export interface DeactivateStaffResult {
  adminUserId: string
  userId: string
  isActive: false
}

export async function deactivateStaff(input: {
  actorUserId: string
  adminUserId: string
  ip?: string
}): Promise<DeactivateStaffResult> {
  return dbWrite.$transaction(async (tx) => {
    const row = await tx.adminUser.findUnique({
      where: { id: input.adminUserId },
      select: { id: true, userId: true, isActive: true },
    })
    if (!row) throw new AppError('STAFF_NOT_FOUND', 'Staff record not found')
    if (row.userId === input.actorUserId) {
      throw new AppError('SELF_TARGET', 'You cannot deactivate your own admin access')
    }
    if (!row.isActive) {
      throw new AppError('VALIDATION_ERROR', 'Staff record is already inactive')
    }

    const claim = await tx.adminUser.updateMany({
      where: { id: row.id, isActive: true },
      data: { isActive: false },
    })
    if (claim.count !== 1) {
      throw new AppError('VALIDATION_ERROR', 'Staff record was changed concurrently')
    }

    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'STAFF_DEACTIVATE',
      targetType: 'staff',
      targetId: row.id,
      before: { isActive: true },
      after: { isActive: false },
      ip: input.ip,
    })

    return { adminUserId: row.id, userId: row.userId, isActive: false }
  })
}
