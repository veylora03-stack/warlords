/**
 * WARLORDS — Unit tests: notification catalog invariants (Phase 22).
 *
 * The catalog is THE contract every producer and the worker share. These
 * tests pin its structural guarantees: every catalogued type has a payload
 * schema + channels (IN_APP mandatory), templates render deterministically
 * from validated payloads, dedupe keys carry event identity within bounded
 * length, and the backoff ladder is monotonic and capped.
 */

import { describe, it, expect } from 'bun:test'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NOTIFICATION_POLICY,
  NOTIFICATION_TYPE_CHANNELS,
  notificationBackoffDelayMs,
  notificationDedupeKeys,
  renderNotification,
  validateNotificationCatalog,
  validateNotificationPayload,
  type NotificationPayloadMap,
} from '../../../src/lib/game/config/notifications'
import { NOTIFICATION_TYPES } from '../../../src/lib/game/types/common'

const REQUIRED_EVENT_TYPES = [
  'ATTACK_INCOMING',
  'ATTACK_RESULT',
  'CONSTRUCTION_COMPLETE',
  'TRAINING_COMPLETE',
  'QUEST_COMPLETED',
  'CLAN_INVITE',
  'CLAN_WAR',
  'WORLD_BOSS',
  'EVENT',
  'RANK_CHANGE',
] as const

describe('notification catalog structure', () => {
  it('covers every type the Phase 22 contract requires (all 10 event kinds + REWARD + ANNOUNCEMENT)', () => {
    for (const type of REQUIRED_EVENT_TYPES) {
      expect(NOTIFICATION_TYPES).toContain(type)
    }
    expect(NOTIFICATION_TYPES).toContain('REWARD')
    expect(NOTIFICATION_TYPES).toContain('ANNOUNCEMENT')
    // Phase 31 adds ACHIEVEMENT_UNLOCKED to the union (permanent honors).
    expect(NOTIFICATION_TYPES).toContain('ACHIEVEMENT_UNLOCKED')
    // Phase 33 adds the march-engine types (army movement lifecycle).
    expect(NOTIFICATION_TYPES).toContain('MARCH_RETURNED')
    expect(NOTIFICATION_TYPES).toContain('MARCH_CANCELLED')
    // Phase 34 adds the clan + positional-garrison types.
    expect(NOTIFICATION_TYPES).toContain('CLAN_JOINED')
    expect(NOTIFICATION_TYPES).toContain('CLAN_LEADERSHIP_CHANGED')
    expect(NOTIFICATION_TYPES).toContain('GARRISON_DEPLOYED')
    expect(NOTIFICATION_TYPES).toContain('GARRISON_WITHDRAWN')
    expect(NOTIFICATION_TYPES).toContain('GARRISON_DESTROYED')
    expect(NOTIFICATION_TYPES.length).toBe(20)
  })

  it('gives every type a payload schema and a non-empty channel list with IN_APP mandatory', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_PAYLOAD_SCHEMAS[type]).toBeDefined()
      const channels = NOTIFICATION_TYPE_CHANNELS[type]
      expect(channels.length).toBeGreaterThan(0)
      expect(channels).toContain('IN_APP')
      for (const channel of channels) {
        expect(NOTIFICATION_CHANNELS).toContain(channel)
      }
    }
  })

  it('marks the time-critical combat/diplomacy/world types for TELEGRAM push', () => {
    for (const type of [
      'ATTACK_INCOMING',
      'ATTACK_RESULT',
      'CLAN_INVITE',
      'CLAN_WAR',
      'WORLD_BOSS',
      'EVENT',
    ] as const) {
      expect(NOTIFICATION_TYPE_CHANNELS[type]).toContain('TELEGRAM')
    }
  })

  it('passes the structural validator with zero problems', () => {
    expect(validateNotificationCatalog()).toEqual([])
  })
})

describe('payload validation (fail-closed at enqueue)', () => {
  it('accepts well-formed payloads', () => {
    const attack = validateNotificationPayload('ATTACK_INCOMING', {
      marchId: 'm1',
      attackerName: 'Warlord A',
      targetCoord: { x: 3, y: 4 },
      arrivesInSeconds: 120,
    })
    expect(attack.attackerName).toBe('Warlord A')
  })

  it('rejects malformed payloads (missing fields, bad ranges, unknown enum values)', () => {
    expect(() => validateNotificationPayload('ATTACK_INCOMING', { marchId: 'm1' })).toThrow()
    expect(() =>
      validateNotificationPayload('ATTACK_RESULT', {
        battleId: 'b1',
        viewerRole: 'SPECTATOR', // not ATTAKER/DEFENDER
        outcome: 'VICTORY',
        opponentName: 'x',
      }),
    ).toThrow()
    expect(() =>
      validateNotificationPayload('TRAINING_COMPLETE', {
        unitId: 'u1',
        unitName: 'Swordsman',
        count: 0, // count must be ≥ 1
      }),
    ).toThrow()
    expect(() => validateNotificationPayload('RANK_CHANGE', { kind: 'MYSTERY' })).toThrow()
  })

  it('validates the RANK_CHANGE discriminated union for both real producers', () => {
    const levelUp = validateNotificationPayload('RANK_CHANGE', {
      kind: 'LEVEL_UP',
      level: 2,
      levelsGained: 1,
      source: 'test',
    })
    expect(levelUp.kind).toBe('LEVEL_UP')

    const seasonRank = validateNotificationPayload('RANK_CHANGE', {
      kind: 'SEASON_RANK',
      seasonNumber: 1,
      rank: 3,
      tier: 'GOLD',
      score: 420,
      rewardReady: true,
    })
    expect(seasonRank.kind).toBe('SEASON_RANK')
  })
})

describe('server-side rendering', () => {
  it('renders deterministic title/body from validated payloads only', () => {
    const attack = validateNotificationPayload('ATTACK_INCOMING', {
      marchId: 'm1',
      attackerName: 'Raider',
      targetCoord: { x: 7, y: 9 },
      arrivesInSeconds: 45,
    }) as NotificationPayloadMap['ATTACK_INCOMING']
    const rendered = renderNotification('ATTACK_INCOMING', attack)
    expect(rendered.title).toBe('Attack incoming from Raider')
    expect(rendered.body).toBe('Enemy forces are marching on your city (7,9) — arrival in ~45s.')
  })

  it('renders both RANK_CHANGE kinds with their distinct wording', () => {
    const levelUp = renderNotification('RANK_CHANGE', {
      kind: 'LEVEL_UP',
      level: 5,
      levelsGained: 2,
    })
    expect(levelUp.title).toBe('Level 5 reached')

    const seasonRank = renderNotification('RANK_CHANGE', {
      kind: 'SEASON_RANK',
      seasonNumber: 3,
      rank: 12,
      tier: 'SILVER',
      score: 310,
      rewardReady: true,
    })
    expect(seasonRank.title).toContain('rank #12')
    expect(seasonRank.body).toContain('SILVER')
    expect(seasonRank.body).toContain('ready to claim')
  })

  it('renders attack results with outcome + role + optional loot', () => {
    const victory = renderNotification('ATTACK_RESULT', {
      battleId: 'b1',
      viewerRole: 'ATTACKER',
      outcome: 'VICTORY',
      opponentName: 'Defender',
      lootSummary: 'Plundered 500 gold.',
    })
    expect(victory.title).toBe('Battle report — Victory')
    expect(victory.body).toContain('attack on Defender')
    expect(victory.body).toContain('Plundered 500 gold.')
  })
})

describe('dedupe keys carry event identity', () => {
  it('keys differ per occurrence of the same entity', () => {
    // Same building, two different level-ups → two distinct notifications.
    expect(notificationDedupeKeys.construction('b1', 2)).not.toBe(
      notificationDedupeKeys.construction('b1', 3),
    )
    // Same player, two different levels → distinct.
    expect(notificationDedupeKeys.levelUp('p1', 2)).not.toBe(
      notificationDedupeKeys.levelUp('p1', 3),
    )
    // The same key IS stable for the same event (idempotent enqueue).
    expect(notificationDedupeKeys.training('q1')).toBe(notificationDedupeKeys.training('q1'))
  })

  it('produces bounded key strings (1..200) for every builder', () => {
    for (const builder of Object.values(notificationDedupeKeys)) {
      const key = (builder as (...args: unknown[]) => string)('id', 1, 'PHASE')
      expect(key.length).toBeGreaterThan(0)
      expect(key.length).toBeLessThanOrEqual(200)
    }
  })
})

describe('backoff ladder', () => {
  it('grows exponentially from the base and is capped', () => {
    expect(notificationBackoffDelayMs(1)).toBe(NOTIFICATION_POLICY.backoffBaseMs)
    expect(notificationBackoffDelayMs(2)).toBe(NOTIFICATION_POLICY.backoffBaseMs * 2)
    expect(notificationBackoffDelayMs(3)).toBe(NOTIFICATION_POLICY.backoffBaseMs * 4)
    for (let attempt = 1; attempt <= 30; attempt++) {
      expect(notificationBackoffDelayMs(attempt)).toBeLessThanOrEqual(
        NOTIFICATION_POLICY.backoffMaxMs,
      )
    }
  })

  it('is monotonic within the policy attempts bound', () => {
    let previous = 0
    for (let attempt = 1; attempt <= NOTIFICATION_POLICY.maxAttempts; attempt++) {
      const delay = notificationBackoffDelayMs(attempt)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })
})
