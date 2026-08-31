/**
 * WARLORDS — Prisma error classifiers (shared, cycle-free).
 *
 * Extracted into its own leaf module so services in a dependency chain
 * (bootstrap → notification engine → registration) can all use it without
 * importing each other.
 */

import { Prisma } from '@prisma/client'

/** True for Prisma unique-constraint violations (P2002). */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}
