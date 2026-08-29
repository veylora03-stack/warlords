/**
 * WARLORDS — Player bootstrap service.
 *
 * Creates the FULL player state in ONE transaction (sensitive-operation rule):
 * player → wallet → ledger faucet rows → city → starter buildings → starter
 * army → starter quests → welcome notification. Any failure rolls back
 * everything — a half-bootstrapped player can never exist.
 *
 * The caller owns the transaction: pass `tx` from `db.$transaction(...)`.
 * Consumers: dev seed (prisma/seed.ts) now; auth signup service (next phase).
 */

import type { Prisma } from '@prisma/client'
import {
  STARTER_BUILDINGS,
  STARTER_BUILDING_LEVEL,
  STARTER_ENERGY,
  STARTER_QUEST_IDS,
  STARTER_UNITS,
  STARTER_WALLET,
} from '@/lib/game/config/starter'

export type Tx = Prisma.TransactionClient

export interface BootstrapPlayerInput {
  userId: string
  name: string
  city: { x: number; y: number }
}

export interface BootstrapPlayerResult {
  playerId: string
  cityId: string
}

export async function bootstrapPlayer(
  tx: Tx,
  input: BootstrapPlayerInput,
): Promise<BootstrapPlayerResult> {
  const now = new Date()

  // 1) Player row (premium/action currencies live on Player, resources on wallet)
  const player = await tx.player.create({
    data: {
      userId: input.userId,
      name: input.name,
      energy: STARTER_ENERGY,
      energyUpdatedAt: now,
    },
    select: { id: true },
  })

  // 2) Resource wallet — the cache. The ledger rows below are the truth.
  await tx.resourceWallet.create({
    data: {
      playerId: player.id,
      gold: STARTER_WALLET.GOLD,
      wood: STARTER_WALLET.WOOD,
      iron: STARTER_WALLET.IRON,
      food: STARTER_WALLET.FOOD,
      crystal: STARTER_WALLET.CRYSTAL,
      capacityUpdatedAt: now,
    },
  })

  // 3) Ledger faucet: one append per resource with balanceAfter (invariant: Σdelta = balance)
  await tx.resourceTransaction.createMany({
    data: Object.entries(STARTER_WALLET).map(([resource, amount]) => ({
      playerId: player.id,
      resource,
      delta: amount,
      balanceAfter: amount,
      reason: 'BOOTSTRAP',
    })),
  })

  // 4) Capital city at caller-provided free coordinates
  const city = await tx.city.create({
    data: {
      playerId: player.id,
      name: `${input.name}'s Keep`,
      x: input.city.x,
      y: input.city.y,
    },
    select: { id: true },
  })

  // 5) Starter buildings — one of each type at level 1
  await tx.building.createMany({
    data: STARTER_BUILDINGS.map((type) => ({
      cityId: city.id,
      type,
      level: STARTER_BUILDING_LEVEL,
    })),
  })

  // 6) Starter army
  await tx.playerUnit.createMany({
    data: STARTER_UNITS.map((u) => ({
      playerId: player.id,
      unitId: u.unitId,
      count: u.count,
    })),
  })

  // 7) Starter quests — read catalog targets inside the tx (single source: DB)
  const starterQuests = await tx.quest.findMany({
    where: { id: { in: [...STARTER_QUEST_IDS] }, isActive: true },
    select: { id: true, objectiveTarget: true },
  })
  if (starterQuests.length !== STARTER_QUEST_IDS.length) {
    throw new Error(
      `Starter quests missing from quest catalog: expected [${STARTER_QUEST_IDS.join(', ')}] — run the seed pipeline first`,
    )
  }
  await tx.playerQuest.createMany({
    data: starterQuests.map((q) => {
      const target = (q.objectiveTarget as { amount?: number })['amount'] ?? 1
      return {
        playerId: player.id,
        questId: q.id,
        target,
        status: 'ACTIVE',
      }
    }),
  })

  // 8) Welcome notification (outbox pattern — IN_APP first)
  await tx.notification.create({
    data: {
      playerId: player.id,
      type: 'REWARD',
      title: 'Welcome to WARLORDS',
      body: 'Your keep stands. Collect resources, train troops, and prepare for war.',
    },
  })

  return { playerId: player.id, cityId: city.id }
}
