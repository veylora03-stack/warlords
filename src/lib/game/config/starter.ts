/**
 * WARLORDS — Starter kit & development fixtures.
 *
 * Every number a new player (or the dev seed) receives lives HERE and only
 * here — bootstrap services read this config, so rebalancing never touches
 * logic. Amounts are absolute; timers in seconds.
 */

import type { BuildingType, Coordinate } from '@/lib/game/types/common'
import { BUILDING_TYPES } from '@/lib/game/types/common'

// ── Starter wallet (ledger faucet 'BOOTSTRAP') ───────────────────────────────

export const STARTER_WALLET = {
  GOLD: 1500,
  WOOD: 800,
  IRON: 400,
  FOOD: 600,
  CRYSTAL: 20,
} as const satisfies Record<string, number>

export const STARTER_ENERGY = 100

// ── Starter buildings: one of each type at level 1 ───────────────────────────

export const STARTER_BUILDING_LEVEL = 1

export const STARTER_BUILDINGS: BuildingType[] = [...BUILDING_TYPES]

// ── Starter army ─────────────────────────────────────────────────────────────

export const STARTER_UNITS: Array<{ unitId: string; count: number }> = [
  { unitId: 'militia', count: 20 },
  { unitId: 'archer', count: 10 },
]

// ── Starter quests: MAIN chain head assigned at bootstrap ────────────────────

export const STARTER_QUEST_IDS = ['main-01-first-steps', 'main-02-raise-army'] as const

// ── Season 1 definition (seed) ───────────────────────────────────────────────

export const SEASON_1 = {
  number: 1,
  name: 'Season 1 — Age of Warlords',
  durationDays: 30,
} as const

// ── Development fixtures (dev seed only — never used in production flows) ────

export interface DevPlayerFixture {
  telegramId: string
  name: string
  city: Coordinate
}

export const DEV_PLAYERS: DevPlayerFixture[] = [
  { telegramId: '700000001', name: 'DevWarlord', city: { x: 10, y: 10 } },
  { telegramId: '700000002', name: 'DevRival', city: { x: 11, y: 10 } },
]

/** Dev admin seeded into admin_users (env allowlist takes precedence when set). */
export const DEV_ADMIN = { telegramId: '600000001', name: 'DevAdmin' } as const
