/**
 * WARLORDS — Shared test cleanup helper (Phase 32, hardened in Phase 34).
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
 *
 * Phase 34 hardening: several relations are Restrict by design (audit
 * integrity) and BLOCK the user delete on their own:
 *   battles.attackerPlayerId · clans.leaderPlayerId ·
 *   market_orders.sellerPlayerId · market_transactions.buyer/seller ·
 *   clan_invitations.invitedById · game_events.createdById
 * A silently swallowed delete failure used to leave half-purged users behind
 * (kept their auth row, lost their capital) which poisoned every LATER run
 * that re-registered the same telegram id — the helper now removes every
 * Restrict blocker explicitly and FAILS LOUDLY if a user row still cannot go.
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

    // 1c) Phase 34: Restrict-protected rows that would block the user delete.
    //     Battle rounds cascade with their battle; clan members/invitations
    //     cascade with their clan; garrison contributions cascade with the
    //     player — everything below is deleted BEFORE the users.
    await db.marketTransaction.deleteMany({
      where: {
        OR: [{ buyerPlayerId: { in: playerIds } }, { sellerPlayerId: { in: playerIds } }],
      },
    })
    await db.marketOrder.deleteMany({ where: { sellerPlayerId: { in: playerIds } } })
    await db.battle.deleteMany({
      where: {
        OR: [{ attackerPlayerId: { in: playerIds } }, { defenderPlayerId: { in: playerIds } }],
      },
    })
    await db.clanInvitation.deleteMany({
      where: {
        OR: [{ playerId: { in: playerIds } }, { invitedById: { in: playerIds } }],
      },
    })
    await db.clanMember.deleteMany({ where: { playerId: { in: playerIds } } })
    await db.clan.deleteMany({ where: { leaderPlayerId: { in: playerIds } } })
    await db.gameEvent.deleteMany({ where: { createdById: { in: userIds } } })
  }

  // 2) Restrict-referencing rows (audit) first, then users per row.
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  const failed: string[] = []
  for (const id of userIds) {
    const row = users.find((u) => u.id === id)
    try {
      await db.user.delete({ where: { id } })
    } catch (error) {
      // FAIL LOUDLY: a half-purged user (auth row alive, capital gone)
      // poisons every later run that re-registers this telegram id.
      failed.push(`${row?.player?.id ?? 'no-player'}: ${(error as Error).message.slice(0, 160)}`)
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `purgeTestUsersByTelegramPrefix(${prefix}) could not delete ${failed.length}/${userIds.length} users:\n${failed.join('\n')}`,
    )
  }
}
