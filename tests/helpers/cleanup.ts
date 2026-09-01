/**
 * WARLORDS — Shared test cleanup helper (Phase 32).
 *
 * Deleting several users in ONE bulk `deleteMany` can transiently violate
 * FK ordering under the SQLite foreign-key emulation (the statement spans
 * multiple cascade roots; the reported P2003 surfaces on the User model).
 * Since Phase 32 every player also owns a capital territory, widening the
 * cascade surface. Deleting users PER ROW is cheap at test scale and fully
 * reliable — every suite cleanup goes through this helper.
 *
 * Territory hygiene: every player's holdings (capital + conquests) are reset
 * to inert unclaimed cells BEFORE the user rows go away — the shared sandbox
 * world stays structurally consistent (no abandoned CONTROLLED cells) no
 * matter which suite ran.
 */

import type { PrismaClient } from '@prisma/client'

export async function purgeTestUsersByTelegramPrefix(
  db: PrismaClient,
  prefix: string,
): Promise<void> {
  const users = await db.user.findMany({
    where: { telegramId: { startsWith: prefix } },
    select: { id: true, player: { select: { id: true } } },
  })
  if (users.length === 0) return
  const userIds = users.map((u) => u.id)
  const playerIds = users.flatMap((u) => (u.player ? [u.player.id] : []))

  // 1) Reset every owned territory so the world grid stays claimable and
  //    structurally consistent after the owners disappear.
  if (playerIds.length > 0) {
    await db.territory.updateMany({
      where: { ownerPlayerId: { in: playerIds } },
      data: {
        ownerPlayerId: null,
        ownerType: 'NONE',
        status: 'UNCLAIMED',
        isCapital: false,
        type: 'NPC_VILLAGE',
        terrain: 'PLAINS',
        name: null,
        lastCapturedAt: null,
        productionCollectedAt: null,
      },
    })
    // 1b) Phase 33: marches reference battles (SetNull) and territories
    //     (SetNull) — clear them before the battle/user rows go away.
    await db.march.deleteMany({ where: { playerId: { in: playerIds } } })
    await db.scoutReport.deleteMany({
      where: {
        OR: [{ attackerPlayerId: { in: playerIds } }, { targetPlayerId: { in: playerIds } }],
      },
    })
  }
  // 2) Restrict-referencing rows (audit) first, then users per row.
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  for (const id of userIds) {
    await db.user.delete({ where: { id } }).catch(() => undefined)
  }
}
