/**
 * WARLORDS — Development seed (idempotent).
 *
 * Run: `bun run db:seed` (or automatically via `prisma migrate reset`).
 *
 * Pipeline:
 *   1. Catalogs: units, technologies, quests, achievements, items — upserted
 *      from src/lib/game/config (data-driven; safe to re-run after balance edits).
 *   2. Season 1 — ACTIVE season row for season points/leaderboards.
 *   3. Dev admin — from env ADMIN_TELEGRAM_IDS when set, else the dev fixture.
 *   4. Two dev players bootstrapped via the REAL transactional bootstrap
 *      service (wallet + ledger + city + 17 buildings + army + quests).
 *      Re-running never duplicates (upsert by telegramId / unique keys).
 */

import { PrismaClient, Prisma } from '@prisma/client'
import { getEnv } from '@/config/env'
import { logger } from '@/lib/logger'
import { ACHIEVEMENTS } from '@/lib/game/config/achievements'
import { COSMETICS, TITLES } from '@/lib/game/config/seasons'
import { ITEMS } from '@/lib/game/config/items'
import { QUESTS } from '@/lib/game/config/quests'
import { TECHNOLOGIES } from '@/lib/game/config/technologies'
import { UNITS } from '@/lib/game/config/units'
import { DEV_ADMIN, DEV_PLAYERS, SEASON_1 } from '@/lib/game/config/starter'
import { bootstrapPlayer } from '@/lib/game/services/player-bootstrap.service'

const prisma = new PrismaClient({ log: ['warn', 'error'] })
const log = logger.child({ module: 'seed' })

/** Config interfaces → Prisma JSON input (structural → nominal bridge). */
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

async function seedCatalogs() {
  for (const u of UNITS) {
    await prisma.unit.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        name: u.name,
        class: u.class,
        tier: u.tier,
        attack: u.attack,
        defense: u.defense,
        health: u.health,
        speed: u.speed,
        foodUpkeep: u.foodUpkeep,
        carryCapacity: u.carryCapacity,
        trainingCost: json(u.trainingCost),
        trainingTimeSec: u.trainingTimeSec,
        trainingBuilding: u.trainingBuilding,
        requiredBuildingLevel: u.requiredBuildingLevel,
        strongAgainst: json(u.strongAgainst),
        weakAgainst: json(u.weakAgainst),
        description: u.description,
        isActive: true,
      },
      update: {
        name: u.name,
        class: u.class,
        tier: u.tier,
        attack: u.attack,
        defense: u.defense,
        health: u.health,
        speed: u.speed,
        foodUpkeep: u.foodUpkeep,
        carryCapacity: u.carryCapacity,
        trainingCost: json(u.trainingCost),
        trainingTimeSec: u.trainingTimeSec,
        trainingBuilding: u.trainingBuilding,
        requiredBuildingLevel: u.requiredBuildingLevel,
        strongAgainst: json(u.strongAgainst),
        weakAgainst: json(u.weakAgainst),
        description: u.description,
        isActive: true,
      },
    })
  }

  // Soft-retire catalog rows that left the roster (e.g. the Phase 2 baseline
  // militia/scout/light_cavalry): never hard-deleted (Restrict FKs), never
  // trainable again — the roster in config is the single source of truth.
  const rosterIds = new Set(UNITS.map((u) => u.id))
  const retired = await prisma.unit.updateMany({
    where: { id: { notIn: [...rosterIds] }, isActive: true },
    data: { isActive: false },
  })
  if (retired.count > 0) {
    log.info('retired units outside the roster', { count: retired.count })
  }

  for (const t of TECHNOLOGIES) {
    await prisma.technology.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        name: t.name,
        branch: t.branch,
        tier: t.tier,
        maxLevel: t.maxLevel,
        prerequisites: json(t.prerequisites),
        costPerLevel: json(t.costPerLevel),
        effectsPerLevel: json(t.effectsPerLevel),
        researchTimeSecPerLevel: t.researchTimeSecPerLevel,
        description: t.description,
      },
      update: {
        name: t.name,
        branch: t.branch,
        tier: t.tier,
        maxLevel: t.maxLevel,
        prerequisites: json(t.prerequisites),
        costPerLevel: json(t.costPerLevel),
        effectsPerLevel: json(t.effectsPerLevel),
        researchTimeSecPerLevel: t.researchTimeSecPerLevel,
        description: t.description,
      },
    })
  }

  for (const q of QUESTS) {
    await prisma.quest.upsert({
      where: { id: q.id },
      create: {
        id: q.id,
        type: q.type,
        title: q.title,
        description: q.description,
        objectiveType: q.objectiveType,
        objectiveTarget: json(q.objectiveTarget),
        reward: json(q.reward),
        prerequisiteQuestIds: json(q.prerequisiteQuestIds),
        minLevel: q.minLevel,
        repeatable: q.repeatable,
        cooldownHours: q.cooldownHours,
        sortOrder: q.sortOrder,
      },
      update: {
        type: q.type,
        title: q.title,
        description: q.description,
        objectiveType: q.objectiveType,
        objectiveTarget: json(q.objectiveTarget),
        reward: json(q.reward),
        prerequisiteQuestIds: json(q.prerequisiteQuestIds),
        minLevel: q.minLevel,
        repeatable: q.repeatable,
        cooldownHours: q.cooldownHours,
        sortOrder: q.sortOrder,
      },
    })
  }

  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        title: a.title,
        description: a.description,
        category: a.category,
        metric: a.metric,
        meta: a.meta ? json(a.meta) : Prisma.DbNull,
        target: a.target,
        reward: json(a.reward),
      },
      update: {
        title: a.title,
        description: a.description,
        category: a.category,
        metric: a.metric,
        meta: a.meta ? json(a.meta) : Prisma.DbNull,
        target: a.target,
        reward: json(a.reward),
      },
    })
  }

  for (const t of TITLES) {
    await prisma.title.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        name: t.name,
        rarity: t.rarity,
        source: t.source,
        sortOrder: t.sortOrder,
      },
      update: {
        name: t.name,
        rarity: t.rarity,
        source: t.source,
        sortOrder: t.sortOrder,
      },
    })
  }

  for (const c of COSMETICS) {
    await prisma.cosmetic.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        rarity: c.rarity,
        source: c.source,
      },
      update: {
        name: c.name,
        kind: c.kind,
        rarity: c.rarity,
        source: c.source,
      },
    })
  }

  for (const i of ITEMS) {
    await prisma.item.upsert({
      where: { id: i.id },
      create: {
        id: i.id,
        name: i.name,
        slot: i.slot,
        rarity: i.rarity,
        stats: json(i.stats),
        effects: json(i.effects),
        stackable: i.stackable,
        sellable: i.sellable,
        basePrice: i.basePrice,
        description: i.description,
      },
      update: {
        name: i.name,
        slot: i.slot,
        rarity: i.rarity,
        stats: json(i.stats),
        effects: json(i.effects),
        stackable: i.stackable,
        sellable: i.sellable,
        basePrice: i.basePrice,
        description: i.description,
      },
    })
  }

  log.info('catalogs seeded', {
    units: UNITS.length,
    technologies: TECHNOLOGIES.length,
    quests: QUESTS.length,
    achievements: ACHIEVEMENTS.length,
    items: ITEMS.length,
    titles: TITLES.length,
    cosmetics: COSMETICS.length,
  })
}

async function seedSeason() {
  const now = new Date()
  const endsAt = new Date(now.getTime() + SEASON_1.durationDays * 24 * 3600 * 1000)
  await prisma.season.upsert({
    where: { number: SEASON_1.number },
    create: {
      number: SEASON_1.number,
      name: SEASON_1.name,
      startsAt: now,
      endsAt,
      status: 'ACTIVE',
    },
    update: { name: SEASON_1.name },
  })
  log.info('season seeded', { number: SEASON_1.number })
}

async function seedDevAdmin() {
  const env = getEnvSafeOrThrow()
  const adminTelegramId = env.ADMIN_TELEGRAM_IDS[0]?.toString() ?? DEV_ADMIN.telegramId
  const user = await prisma.user.upsert({
    where: { telegramId: adminTelegramId },
    create: {
      telegramId: adminTelegramId,
      username: 'warlords_admin',
      firstName: 'WARLORDS Admin',
      role: 'SUPERADMIN',
    },
    update: { role: 'SUPERADMIN' },
  })
  await prisma.adminUser.upsert({
    where: { userId: user.id },
    create: { userId: user.id, role: 'SUPERADMIN' },
    update: { role: 'SUPERADMIN', isActive: true },
  })
  log.info('admin seeded', { telegramId: adminTelegramId })
}

function getEnvSafeOrThrow() {
  return getEnv()
}

async function seedDevPlayers() {
  for (const fixture of DEV_PLAYERS) {
    const user = await prisma.user.upsert({
      where: { telegramId: fixture.telegramId },
      create: {
        telegramId: fixture.telegramId,
        username: fixture.name.toLowerCase(),
        firstName: fixture.name,
      },
      update: {},
    })

    const existing = await prisma.player.findUnique({ where: { userId: user.id } })
    if (existing) {
      log.info('dev player exists, skipping bootstrap', { name: fixture.name })
      continue
    }

    // THE sensitive-operation pattern: full player state in one transaction.
    const result = await prisma.$transaction(async (tx) =>
      bootstrapPlayer(tx, { userId: user.id, name: fixture.name, city: fixture.city }),
    )
    log.info('dev player bootstrapped', { name: fixture.name, ...result })
  }
}

async function main() {
  await seedCatalogs()
  await seedSeason()
  await seedDevAdmin()
  await seedDevPlayers()
  log.info('seed complete')
}

main()
  .catch((err) => {
    log.error('seed failed', { err })
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
