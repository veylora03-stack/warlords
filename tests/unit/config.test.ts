/**
 * Unit tests — game config catalog invariants.
 *
 * These tests guard the DATA layer: invalid balance data must fail tests
 * before it can ever reach the seed pipeline. Mirrors the DB-level checks
 * in scripts/db-verify.ts but runs without a database.
 */

import { describe, it, expect } from 'bun:test'
import {
  UNITS,
  TECHNOLOGIES,
  QUESTS,
  ACHIEVEMENTS,
  ITEMS,
  OBJECTIVE_TYPES,
  REWARD_KEYS,
} from '../../src/lib/game/config'
import {
  STARTER_WALLET,
  STARTER_BUILDINGS,
  STARTER_UNITS,
  STARTER_QUEST_IDS,
} from '../../src/lib/game/config/starter'
import {
  BUILDING_TYPES,
  RESOURCES,
  UNIT_CLASSES,
  RARITIES,
  ITEM_SLOTS,
} from '../../src/lib/game/types/common'

describe('units catalog', () => {
  const ids = UNITS.map((u) => u.id)

  it('has unique ids', () => {
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has positive combat stats, speed, upkeep and training time', () => {
    for (const u of UNITS) {
      expect(u.attack).toBeGreaterThan(0)
      expect(u.defense).toBeGreaterThan(0)
      expect(u.health).toBeGreaterThan(0)
      expect(u.speed).toBeGreaterThan(0)
      expect(u.foodUpkeep).toBeGreaterThanOrEqual(0)
      expect(u.carryCapacity).toBeGreaterThanOrEqual(0)
      expect(u.trainingTimeSec).toBeGreaterThan(0)
    }
  })

  it('uses valid unit classes', () => {
    for (const u of UNITS) expect(UNIT_CLASSES).toContain(u.class)
  })

  it('training costs only trade resources in positive amounts', () => {
    for (const u of UNITS) {
      const keys = Object.keys(u.trainingCost)
      expect(keys.length).toBeGreaterThan(0)
      for (const [key, value] of Object.entries(u.trainingCost)) {
        expect(RESOURCES).toContain(key)
        expect(value).toBeGreaterThan(0)
      }
    }
  })

  it('counter references resolve and never target self', () => {
    for (const u of UNITS) {
      for (const c of u.strongAgainst) {
        expect(ids).toContain(c.unitId)
        expect(c.unitId).not.toBe(u.id)
        expect(c.bonusBps).toBeGreaterThan(0)
        expect(c.bonusBps).toBeLessThanOrEqual(10_000)
      }
    }
  })

  it('counter triangle is symmetric enough to be data-complete', () => {
    // Every strongAgainst target must exist (covered above); additionally at
    // least the three core classes must appear as attackers in the matrix.
    const attackers = new Set(UNITS.filter((u) => u.strongAgainst.length > 0).map((u) => u.class))
    expect(attackers.has('INFANTRY')).toBe(true)
    expect(attackers.has('RANGED')).toBe(true)
    expect(attackers.has('CAVALRY')).toBe(true)
  })
})

describe('technologies catalog', () => {
  const ids = TECHNOLOGIES.map((t) => t.id)

  it('has unique ids and valid levels', () => {
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TECHNOLOGIES) expect(t.maxLevel).toBeGreaterThanOrEqual(1)
  })

  it('prerequisites reference existing technologies at sane levels', () => {
    for (const t of TECHNOLOGIES) {
      for (const p of t.prerequisites) {
        expect(ids).toContain(p.technologyId)
        expect(p.technologyId).not.toBe(t.id)
        expect(p.level).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('costs and per-level effects are positive bps within bounds', () => {
    for (const t of TECHNOLOGIES) {
      for (const value of Object.values(t.costPerLevel)) {
        expect(value).toBeGreaterThan(0)
      }
      for (const bps of Object.values(t.effectsPerLevel)) {
        expect(bps).toBeGreaterThan(0)
        expect(bps).toBeLessThanOrEqual(10_000)
      }
      expect(t.researchTimeSecPerLevel).toBeGreaterThan(0)
    }
  })

  it('prerequisite graph has no cycles', () => {
    const byId = new Map(TECHNOLOGIES.map((t) => [t.id, t]))
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (id: string): void => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new Error(`cycle at ${id}`)
      visiting.add(id)
      for (const p of byId.get(id)?.prerequisites ?? []) visit(p.technologyId)
      visiting.delete(id)
      done.add(id)
    }
    for (const id of ids) expect(() => visit(id)).not.toThrow()
  })
})

describe('quests catalog', () => {
  const ids = QUESTS.map((q) => q.id)

  it('has unique ids and valid types/objectives', () => {
    expect(new Set(ids).size).toBe(ids.length)
    for (const q of QUESTS) {
      expect(OBJECTIVE_TYPES).toContain(q.objectiveType)
      expect(q.objectiveTarget.amount).toBeGreaterThan(0)
    }
  })

  it('rewards only use known keys in positive amounts', () => {
    for (const q of QUESTS) {
      const keys = Object.keys(q.reward)
      expect(keys.length).toBeGreaterThan(0)
      for (const [key, value] of Object.entries(q.reward)) {
        expect(REWARD_KEYS).toContain(key)
        expect(value).toBeGreaterThan(0)
      }
    }
  })

  it('prerequisites exist and form no cycles', () => {
    const byId = new Map(QUESTS.map((q) => [q.id, q]))
    for (const q of QUESTS) {
      for (const p of q.prerequisiteQuestIds) expect(ids).toContain(p)
    }
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (id: string): void => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new Error(`cycle at ${id}`)
      visiting.add(id)
      for (const p of byId.get(id)?.prerequisiteQuestIds ?? []) visit(p)
      visiting.delete(id)
      done.add(id)
    }
    for (const id of ids) expect(() => visit(id)).not.toThrow()
  })

  it('MAIN chain is ordered by sortOrder (chain head first)', () => {
    const main = QUESTS.filter((q) => q.type === 'MAIN').sort((a, b) => a.sortOrder - b.sortOrder)
    expect(main[0]!.prerequisiteQuestIds).toHaveLength(0)
    for (let i = 1; i < main.length; i++) {
      expect(main[i]!.prerequisiteQuestIds).toContain(main[i - 1]!.id)
    }
  })
})

describe('achievements & items catalogs', () => {
  it('achievement ids are unique with positive targets and valid rewards', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of ACHIEVEMENTS) {
      expect(a.target).toBeGreaterThan(0)
      for (const value of Object.values(a.reward)) expect(value).toBeGreaterThan(0)
    }
  })

  it('item ids are unique with valid slots, rarities and prices', () => {
    const ids = ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of ITEMS) {
      expect(ITEM_SLOTS).toContain(i.slot)
      expect(RARITIES).toContain(i.rarity)
      if (i.basePrice !== null) expect(i.basePrice).toBeGreaterThan(0)
    }
  })
})

describe('starter kit', () => {
  it('wallet uses trade resources in positive amounts', () => {
    for (const [key, value] of Object.entries(STARTER_WALLET)) {
      expect(RESOURCES).toContain(key)
      expect(value).toBeGreaterThan(0)
    }
  })

  it('building list covers every type exactly once', () => {
    expect([...STARTER_BUILDINGS].sort()).toEqual([...BUILDING_TYPES].sort())
    expect(new Set(STARTER_BUILDINGS).size).toBe(BUILDING_TYPES.length)
  })

  it('starter units exist in the unit catalog with positive counts', () => {
    const unitIds = new Set(UNITS.map((u) => u.id))
    for (const s of STARTER_UNITS) {
      expect(unitIds.has(s.unitId)).toBe(true)
      expect(s.count).toBeGreaterThan(0)
    }
  })

  it('starter quests exist in the quest catalog and are MAIN type', () => {
    const byId = new Map(QUESTS.map((q) => [q.id, q]))
    for (const id of STARTER_QUEST_IDS) {
      const q = byId.get(id)
      expect(q).toBeDefined()
      expect(q?.type).toBe('MAIN')
    }
  })
})
