/**
 * Unit tests — Quest engine PURE layer (Phase 31).
 *
 * Everything here runs with zero I/O: objective matching, contribution
 * modes, progress clamping/monotonicity, cycle computation (UTC server
 * clock), expiry windows and reward splitting. These functions are the
 * security boundary of the quest engine — the service layer feeds them
 * exclusively server-derived state.
 */

import { describe, it, expect } from 'bun:test'
import {
  matchesObjective,
  eventContribution,
  applyContribution,
  dailyCycleAt,
  weeklyCycleAt,
  cycleForType,
  expiresAtForType,
  isExpired,
  splitReward,
  summarizeReward,
  questEventKey,
  type QuestEvent,
} from '../../../src/lib/game/engine/quest/progress'

describe('quest engine — objective matching', () => {
  const battleWon: QuestEvent = {
    kind: 'BATTLE_FINISHED',
    won: true,
    role: 'ATTACKER',
    battleId: 'b1',
  }
  const battleLost: QuestEvent = {
    kind: 'BATTLE_FINISHED',
    won: false,
    role: 'ATTACKER',
    battleId: 'b2',
  }

  it('WIN_BATTLES matches only WON battles (either role)', () => {
    expect(matchesObjective('WIN_BATTLES', { amount: 1 }, battleWon)).toBe(true)
    expect(matchesObjective('WIN_BATTLES', { amount: 1 }, { ...battleWon, role: 'DEFENDER' })).toBe(
      true,
    )
    expect(matchesObjective('WIN_BATTLES', { amount: 1 }, battleLost)).toBe(false)
  })

  it('BUILD_UPGRADE honors buildingType and minimum-level gates', () => {
    const event = {
      kind: 'BUILDING_UPGRADED',
      buildingType: 'TOWN_HALL',
      level: 3,
      buildingId: 'x',
    } as const
    expect(matchesObjective('BUILD_UPGRADE', { amount: 1 }, event)).toBe(true)
    expect(matchesObjective('BUILD_UPGRADE', { buildingType: 'TOWN_HALL', amount: 1 }, event)).toBe(
      true,
    )
    expect(matchesObjective('BUILD_UPGRADE', { buildingType: 'BARRACKS', amount: 1 }, event)).toBe(
      false,
    )
    expect(
      matchesObjective('BUILD_UPGRADE', { buildingType: 'TOWN_HALL', level: 2, amount: 1 }, event),
    ).toBe(true)
    expect(
      matchesObjective('BUILD_UPGRADE', { buildingType: 'TOWN_HALL', level: 4, amount: 1 }, event),
    ).toBe(false)
  })

  it('TRAIN_UNITS honors the unitId gate and passes any batch size otherwise', () => {
    const event = {
      kind: 'UNITS_TRAINED',
      unitId: 'swordsman',
      count: 5,
      queueItemId: 'q',
    } as const
    expect(matchesObjective('TRAIN_UNITS', { amount: 1 }, event)).toBe(true)
    expect(matchesObjective('TRAIN_UNITS', { unitId: 'swordsman', amount: 1 }, event)).toBe(true)
    expect(matchesObjective('TRAIN_UNITS', { unitId: 'archer', amount: 1 }, event)).toBe(false)
  })

  it('EARN_RESOURCE matches gated and any-resource credits, never zero-amount', () => {
    const gold = { kind: 'RESOURCES_EARNED', amounts: { GOLD: 100 }, sourceRef: 'x' } as const
    const mixed = {
      kind: 'RESOURCES_EARNED',
      amounts: { GOLD: 10, WOOD: 5 },
      sourceRef: 'y',
    } as const
    const zero = { kind: 'RESOURCES_EARNED', amounts: {}, sourceRef: 'z' } as const
    expect(matchesObjective('EARN_RESOURCE', { resource: 'GOLD', amount: 1 }, gold)).toBe(true)
    expect(matchesObjective('EARN_RESOURCE', { resource: 'GOLD', amount: 1 }, mixed)).toBe(true)
    expect(matchesObjective('EARN_RESOURCE', { resource: 'GEMS', amount: 1 }, gold)).toBe(false)
    expect(matchesObjective('EARN_RESOURCE', { amount: 1 }, zero)).toBe(false)
    expect(matchesObjective('EARN_RESOURCE', { amount: 1 }, mixed)).toBe(true)
  })

  it('SPEND_RESOURCE mirrors EARN matching', () => {
    const spend = { kind: 'RESOURCES_SPENT', amounts: { GOLD: 50 }, sourceRef: 's' } as const
    expect(matchesObjective('SPEND_RESOURCE', { resource: 'GOLD', amount: 1 }, spend)).toBe(true)
    expect(matchesObjective('SPEND_RESOURCE', { resource: 'WOOD', amount: 1 }, spend)).toBe(false)
  })

  it('SET objectives match their own events only; reserved types are inert', () => {
    expect(
      matchesObjective('REACH_POWER', { amount: 1 }, { kind: 'POWER_REACHED', power: 500 }),
    ).toBe(true)
    expect(
      matchesObjective('REACH_LEVEL', { amount: 1 }, { kind: 'LEVEL_REACHED', level: 3 }),
    ).toBe(true)
    expect(matchesObjective('REACH_POWER', { amount: 1 }, battleWon)).toBe(false)
    // No territory/clan/scout events exist — quests using them can never match.
    expect(matchesObjective('CAPTURE_TERRITORIES', { amount: 1 }, battleWon)).toBe(false)
    expect(matchesObjective('JOIN_CLAN', { amount: 1 }, battleWon)).toBe(false)
  })
})

describe('quest engine — contributions & progress', () => {
  it('INCREMENT adds and clamps at the target (no overshoot)', () => {
    const contribution = eventContribution(
      'TRAIN_UNITS',
      { amount: 20 },
      {
        kind: 'UNITS_TRAINED',
        unitId: 'x',
        count: 500,
        queueItemId: 'q',
      },
    )
    expect(contribution).toEqual({ mode: 'INCREMENT', delta: 500 })
    const applied = applyContribution(15, 20, contribution)
    expect(applied.progress).toBe(20)
    expect(applied.completed).toBe(true)
  })

  it('battle wins contribute exactly +1', () => {
    expect(
      eventContribution(
        'WIN_BATTLES',
        { amount: 1 },
        {
          kind: 'BATTLE_FINISHED',
          won: true,
          role: 'DEFENDER',
          battleId: 'b',
        },
      ),
    ).toEqual({ mode: 'INCREMENT', delta: 1 })
  })

  it('resource contributions sum all positive amounts, or the gated resource', () => {
    expect(
      eventContribution(
        'EARN_RESOURCE',
        { amount: 1 },
        {
          kind: 'RESOURCES_EARNED',
          amounts: { GOLD: 100, WOOD: 40 },
          sourceRef: 'x',
        },
      ),
    ).toEqual({ mode: 'INCREMENT', delta: 140 })
    expect(
      eventContribution(
        'EARN_RESOURCE',
        { resource: 'WOOD', amount: 1 },
        {
          kind: 'RESOURCES_EARNED',
          amounts: { GOLD: 100, WOOD: 40 },
          sourceRef: 'x',
        },
      ),
    ).toEqual({ mode: 'INCREMENT', delta: 40 })
  })

  it('SET mode snaps to the event value, never decreases', () => {
    const up = applyContribution(10, 100, { mode: 'SET', value: 99 })
    expect(up).toEqual({ progress: 99, completed: false })
    const atTarget = applyContribution(0, 100, { mode: 'SET', value: 100 })
    expect(atTarget.completed).toBe(true)
    // A power/level drop can never un-complete a quest.
    const down = applyContribution(99, 100, { mode: 'SET', value: 50 })
    expect(down.progress).toBe(99)
  })

  it('progress is idempotent at the boundary (repeat event after completion is moot)', () => {
    const first = applyContribution(0, 1, { mode: 'INCREMENT', delta: 1 })
    expect(first.completed).toBe(true)
    const again = applyContribution(first.progress, 1, { mode: 'INCREMENT', delta: 1 })
    expect(again.progress).toBe(1)
  })

  it('rejects corrupt state and invalid contributions (fail closed)', () => {
    expect(() => applyContribution(-1, 10, { mode: 'INCREMENT', delta: 1 })).toThrow()
    expect(() => applyContribution(0, 0, { mode: 'INCREMENT', delta: 1 })).toThrow()
    expect(() => applyContribution(0, 10, { mode: 'INCREMENT', delta: -5 })).toThrow()
    expect(() => applyContribution(0, 10, { mode: 'SET', value: -1 })).toThrow()
    // A SET objective cannot consume an INCREMENT event (programmer error).
    expect(() =>
      eventContribution(
        'REACH_POWER',
        { amount: 1 },
        {
          kind: 'BATTLE_FINISHED',
          won: true,
          role: 'ATTACKER',
          battleId: 'b',
        },
      ),
    ).toThrow()
  })
})

describe('quest engine — cycles & expiry (UTC server clock)', () => {
  it('daily cycle is the UTC calendar date', () => {
    // 23:59 UTC vs 00:00 UTC next day → different cycles regardless of local tz.
    expect(dailyCycleAt(new Date('2026-09-01T23:59:59.000Z'))).toBe('2026-09-01')
    expect(dailyCycleAt(new Date('2026-09-02T00:00:00.000Z'))).toBe('2026-09-02')
  })

  it('weekly cycle is the ISO-8601 week (Monday-based, UTC)', () => {
    // 2026-09-01 is a Tuesday → ISO week 36.
    expect(weeklyCycleAt(new Date('2026-09-01T12:00:00.000Z'))).toBe('2026-W36')
    // Monday 2026-08-31 and Sunday 2026-09-06 share the same ISO week.
    expect(weeklyCycleAt(new Date('2026-08-31T00:00:00.000Z'))).toBe('2026-W36')
    expect(weeklyCycleAt(new Date('2026-09-06T23:59:59.000Z'))).toBe('2026-W36')
    // ISO year boundary: 2027-01-01 (Friday) is ISO 2026-W53; 2027-01-04 (Monday) is 2027-W01.
    expect(weeklyCycleAt(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-W53')
    expect(weeklyCycleAt(new Date('2027-01-04T00:00:00.000Z'))).toBe('2027-W01')
  })

  it('cycleForType binds SEASONAL to the ACTIVE season and permanents to 0', () => {
    const season = { number: 2, endsAt: new Date('2026-12-31T00:00:00.000Z') }
    const now = new Date('2026-09-01T00:00:00.000Z')
    expect(cycleForType('MAIN', now, season)).toBe('0')
    expect(cycleForType('DAILY', now, season)).toBe('2026-09-01')
    expect(cycleForType('WEEKLY', now, season)).toBe('2026-W36')
    expect(cycleForType('SEASONAL', now, season)).toBe('2')
    // No ACTIVE season → seasonal quests are NOT assignable.
    expect(cycleForType('SEASONAL', now, null)).toBeNull()
  })

  it('expiresAt: daily → next UTC midnight; weekly → next Monday; seasonal → season end', () => {
    const season = { number: 1, endsAt: new Date('2026-12-31T00:00:00.000Z') }
    expect(
      expiresAtForType('DAILY', new Date('2026-09-01T23:59:00.000Z'), null)!.toISOString(),
    ).toBe('2026-09-02T00:00:00.000Z')
    expect(
      expiresAtForType('WEEKLY', new Date('2026-09-01T00:00:00.000Z'), null)!.toISOString(),
    ).toBe(
      '2026-09-07T00:00:00.000Z', // next Monday 00:00 UTC
    )
    expect(expiresAtForType('SEASONAL', new Date('2026-09-01T00:00:00.000Z'), season)).toBe(
      season.endsAt,
    )
    expect(expiresAtForType('MAIN', new Date(), null)).toBeNull()
  })

  it('lazy expiry only flips ACTIVE instances past their horizon', () => {
    const now = new Date('2026-09-02T00:00:01.000Z')
    expect(isExpired('ACTIVE', new Date('2026-09-02T00:00:00.000Z'), now)).toBe(true)
    expect(isExpired('ACTIVE', new Date('2026-09-02T00:00:02.000Z'), now)).toBe(false)
    expect(isExpired('COMPLETED', new Date('2026-09-01T00:00:00.000Z'), now)).toBe(false)
    expect(isExpired('ACTIVE', null, now)).toBe(false)
  })
})

describe('quest engine — rewards', () => {
  it('splits wallet resources, XP and honor; ignores non-positive entries', () => {
    const split = splitReward({ GOLD: 200, WOOD: 0, XP: 100, HONOR: 10, BAD_KEY: 5 })
    expect(split.wallet).toEqual({ GOLD: 200 })
    expect(split.xp).toBe(100)
    expect(split.honor).toBe(10)
    expect(split.unsupported).toEqual(['BAD_KEY'])
  })

  it('unsupported reward keys fail the claim CLOSED (never silently shrink)', () => {
    const split = splitReward({ GEMS: 5, ITEM: 'sword_skin', COMMANDER: 'cmd1', ENERGY: 10 })
    expect(split.wallet).toEqual({ GEMS: 5 })
    expect(split.unsupported).toEqual(['ITEM', 'COMMANDER', 'ENERGY'])
  })

  it('malformed reward JSON splits to nothing (no crash)', () => {
    expect(splitReward(null).wallet).toEqual({})
    expect(splitReward('nonsense' as unknown).unsupported).toEqual([])
    expect(splitReward({ GOLD: 'many' }).wallet).toEqual({})
    expect(splitReward({ GOLD: -5 }).wallet).toEqual({})
  })

  it('reward summary renders deterministically for notifications', () => {
    expect(summarizeReward({ GOLD: 200, XP: 100, HONOR: 10 })).toBe(
      'Reward: 200 GOLD, 100 XP, 10 Honor.',
    )
    expect(summarizeReward({ XP: 40 })).toBe('Reward: 40 XP.')
    expect(summarizeReward({ WOOD: 0 })).toBeUndefined()
  })
})

describe('quest engine — event keys (audit identity)', () => {
  it('keys are distinct per occurrence and stable for the same occurrence', () => {
    const a = questEventKey({
      kind: 'BATTLE_FINISHED',
      won: true,
      role: 'ATTACKER',
      battleId: 'b1',
    })
    const b = questEventKey({
      kind: 'BATTLE_FINISHED',
      won: true,
      role: 'DEFENDER',
      battleId: 'b1',
    })
    expect(a).not.toBe(b) // attacker and defender see distinct event identities
    expect(
      questEventKey({ kind: 'BATTLE_FINISHED', won: true, role: 'ATTACKER', battleId: 'b1' }),
    ).toBe(a)
    expect(
      questEventKey({ kind: 'UNITS_TRAINED', unitId: 'x', count: 1, queueItemId: 'q9' }),
    ).toContain('q9')
    expect(questEventKey({ kind: 'POWER_REACHED', power: 777 })).toBe('POWER_REACHED:777')
  })
})
