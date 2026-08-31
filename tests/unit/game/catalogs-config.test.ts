/**
 * Unit tests — Catalog configs: quests · technologies · items · achievements ·
 * starter kit (Phase 24 QA sweep of previously untested data authorities).
 *
 * These catalogs are the SERVER-SIDE source of truth for future engines
 * (quest engine, research, inventory). Every invariant asserted here is a
 * contract the engines rely on: referential integrity (no dangling
 * prerequisites / reward keys / unit ids), acyclic quest chains, positive
 * amounts, sane sort orders. A broken catalog fails FAST here instead of
 * corrupting player progression at runtime.
 */

import { describe, it, expect } from 'bun:test'
import { QUESTS, OBJECTIVE_TYPES, REWARD_KEYS } from '../../../src/lib/game/config/quests'
import { TECHNOLOGIES } from '../../../src/lib/game/config/technologies'
import { ITEMS } from '../../../src/lib/game/config/items'
import { ACHIEVEMENTS, ACHIEVEMENT_CATEGORIES } from '../../../src/lib/game/config/achievements'
import {
  STARTER_WALLET,
  STARTER_BUILDINGS,
  STARTER_UNITS,
  STARTER_QUEST_IDS,
  STARTER_ENERGY,
  SEASON_1,
  DEV_PLAYERS,
} from '../../../src/lib/game/config/starter'
import { BUILDING_TYPES } from '../../../src/lib/game/types/common'
import { UNITS } from '../../../src/lib/game/config/units'

// ── helpers ──────────────────────────────────────────────────────────────────

function isPositiveFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Detects a cycle in a prerequisite graph via DFS with a visiting set. */
function hasCycle(
  nodes: string[],
  depsOf: (id: string) => string[],
): { cyclic: boolean; badId?: string } {
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, stack: string[]): { cyclic: boolean; badId?: string } => {
    const st = state.get(id)
    if (st === 'visiting') return { cyclic: true, badId: [...stack, id].join(' → ') }
    if (st === 'done') return { cyclic: false }
    state.set(id, 'visiting')
    for (const dep of depsOf(id)) {
      const result = visit(dep, [...stack, id])
      if (result.cyclic) return result
    }
    state.set(id, 'done')
    return { cyclic: false }
  }
  for (const id of nodes) {
    const result = visit(id, [])
    if (result.cyclic) return result
  }
  return { cyclic: false }
}

// ── Quest catalog ────────────────────────────────────────────────────────────

describe('quest catalog (server-owned reward authority)', () => {
  it('has unique, non-empty, kebab-safe ids', () => {
    const ids = QUESTS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0)
      expect(id.length).toBeLessThanOrEqual(64)
      expect(/^[a-z0-9-]+$/.test(id)).toBe(true)
    }
  })

  it('quest types are MAIN or DAILY only', () => {
    for (const q of QUESTS) expect(['MAIN', 'DAILY']).toContain(q.type)
  })

  it('every prerequisite references an existing quest (no dangling ids)', () => {
    const ids = new Set(QUESTS.map((q) => q.id))
    for (const q of QUESTS) {
      for (const pre of q.prerequisiteQuestIds) {
        expect(ids.has(pre)).toBe(true)
        expect(pre).not.toBe(q.id) // self-reference is a trivial cycle
      }
    }
  })

  it('prerequisite graph is acyclic (quest chains always completable)', () => {
    const result = hasCycle(
      QUESTS.map((q) => q.id),
      (id) => QUESTS.find((q) => q.id === id)?.prerequisiteQuestIds ?? [],
    )
    expect(result.cyclic).toBe(false)
  })

  it('reward keys are understood by the reward service; amounts positive', () => {
    for (const q of QUESTS) {
      for (const [key, amount] of Object.entries(q.reward)) {
        expect(REWARD_KEYS).toContain(key)
        expect(isPositiveFiniteInt(amount)).toBe(true)
      }
    }
  })

  it('objective amounts are positive; objective types are blessed', () => {
    for (const q of QUESTS) {
      expect(OBJECTIVE_TYPES).toContain(q.objectiveType)
      expect(isPositiveFiniteInt(q.objectiveTarget.amount)).toBe(true)
    }
  })

  it('repeatable quests have cooldowns; one-shot quests have none', () => {
    for (const q of QUESTS) {
      if (q.repeatable) expect(q.cooldownHours).toBeGreaterThan(0)
      else expect(q.cooldownHours).toBe(0)
    }
  })

  it('sort orders are unique and positive (deterministic UI ordering)', () => {
    const orders = QUESTS.map((q) => q.sortOrder)
    expect(new Set(orders).size).toBe(orders.length)
    for (const order of orders) expect(order).toBeGreaterThan(0)
  })

  it('resource-collect objectives name real economy resources', () => {
    for (const q of QUESTS) {
      if (q.objectiveType === 'COLLECT_RESOURCE') {
        expect(['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']).toContain(q.objectiveTarget.resource)
      }
    }
  })
})

// ── Technology catalog ───────────────────────────────────────────────────────

describe('technology catalog (research prerequisites & costs)', () => {
  it('has unique ids', () => {
    const ids = TECHNOLOGIES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every prerequisite references an existing technology at a reachable level', () => {
    const byId = new Map(TECHNOLOGIES.map((t) => [t.id, t]))
    for (const t of TECHNOLOGIES) {
      for (const pre of t.prerequisites) {
        const dep = byId.get(pre.technologyId)
        expect(dep).toBeDefined()
        if (!dep) continue
        expect(pre.level).toBeGreaterThanOrEqual(1)
        expect(pre.level).toBeLessThanOrEqual(dep.maxLevel)
        // A tier-N technology can only require tier < N (no forward jumps).
        expect(dep.tier).toBeLessThan(t.tier)
      }
    }
  })

  it('maxLevel ≥ 1 and costs/effects/research times are positive finite', () => {
    for (const t of TECHNOLOGIES) {
      expect(t.maxLevel).toBeGreaterThanOrEqual(1)
      expect(t.tier).toBeGreaterThanOrEqual(1)
      expect(t.researchTimeSecPerLevel).toBeGreaterThan(0)
      for (const amount of Object.values(t.costPerLevel)) {
        expect(isPositiveFiniteInt(amount)).toBe(true)
      }
      for (const bps of Object.values(t.effectsPerLevel)) {
        expect(Number.isFinite(bps)).toBe(true)
        expect(bps).toBeGreaterThan(0)
        expect(bps).toBeLessThanOrEqual(10_000) // bps domain: ≤ 100%
      }
    }
  })

  it('no negative costs can ever be charged (money-printing impossible)', () => {
    for (const t of TECHNOLOGIES) {
      for (const [key, amount] of Object.entries(t.costPerLevel)) {
        expect(['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']).toContain(key)
        expect(amount).toBeGreaterThan(0)
      }
    }
  })
})

// ── Item catalog ─────────────────────────────────────────────────────────────

describe('item catalog (inventory & economy hygiene)', () => {
  it('has unique ids', () => {
    const ids = ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sellable items always carry a positive base price (no free gold exploits)', () => {
    for (const item of ITEMS) {
      if (item.sellable) {
        expect(item.basePrice).not.toBeNull()
        expect(isPositiveFiniteInt(item.basePrice)).toBe(true)
      }
    }
  })

  it('speedup consumables reduce a positive, bounded number of seconds', () => {
    for (const item of ITEMS) {
      const seconds = item.effects.secondsReduced
      if (seconds !== undefined) {
        expect(item.slot).toBe('CONSUMABLE')
        expect(isPositiveFiniteInt(seconds)).toBe(true)
        expect(seconds).toBeLessThanOrEqual(86_400)
      }
    }
  })

  it('chest grants reference existing item ids (no dangling rewards)', () => {
    const ids = new Set(ITEMS.map((i) => i.id))
    for (const item of ITEMS) {
      for (const granted of item.effects.grants ?? []) {
        expect(typeof granted).toBe('string')
        expect(ids.has(granted as string)).toBe(true)
      }
    }
  })

  it('stat bonuses are finite and within the bps/absolute domain', () => {
    for (const item of ITEMS) {
      for (const value of Object.values(item.stats)) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

// ── Achievement catalog ──────────────────────────────────────────────────────

describe('achievement catalog (server-evaluated unlocks)', () => {
  it('has unique ids', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('categories are blessed; targets are positive integers', () => {
    for (const a of ACHIEVEMENTS) {
      expect(ACHIEVEMENT_CATEGORIES).toContain(a.category)
      expect(isPositiveFiniteInt(a.target)).toBe(true)
    }
  })

  it('rewards use understood keys with positive amounts', () => {
    for (const a of ACHIEVEMENTS) {
      for (const [key, amount] of Object.entries(a.reward)) {
        expect(REWARD_KEYS).toContain(key)
        expect(isPositiveFiniteInt(amount)).toBe(true)
      }
    }
  })
})

// ── Starter kit ──────────────────────────────────────────────────────────────

describe('starter kit (bootstrap faucet)', () => {
  it('wallet amounts are positive integers for every economy resource', () => {
    const expected = ['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL'] as const
    for (const resource of expected) {
      const amount = STARTER_WALLET[resource]
      expect(isPositiveFiniteInt(amount)).toBe(true)
    }
    // No hidden extra resources (unknown keys would silently drop).
    expect(Object.keys(STARTER_WALLET).sort()).toEqual([...expected].sort())
  })

  it('starter buildings cover every building type exactly once', () => {
    expect([...STARTER_BUILDINGS].sort()).toEqual([...BUILDING_TYPES].sort())
  })

  it('starter units exist in the roster with positive counts', () => {
    const rosterIds = new Set(UNITS.map((u) => u.id))
    for (const { unitId, count } of STARTER_UNITS) {
      expect(rosterIds.has(unitId)).toBe(true)
      expect(isPositiveFiniteInt(count)).toBe(true)
    }
  })

  it('starter quest ids reference existing quest catalog entries', () => {
    const questIds = new Set(QUESTS.map((q) => q.id))
    for (const id of STARTER_QUEST_IDS) expect(questIds.has(id)).toBe(true)
  })

  it('energy, season 1 and dev fixtures are sane', () => {
    expect(STARTER_ENERGY).toBeGreaterThan(0)
    expect(SEASON_1.durationDays).toBeGreaterThan(0)
    expect(SEASON_1.number).toBe(1)
    for (const dev of DEV_PLAYERS) {
      expect(dev.telegramId).toMatch(/^\d+$/)
      expect(dev.name.length).toBeGreaterThan(0)
      expect(Number.isFinite(dev.city.x)).toBe(true)
      expect(Number.isFinite(dev.city.y)).toBe(true)
    }
  })
})
