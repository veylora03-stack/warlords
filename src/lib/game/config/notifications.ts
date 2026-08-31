/**
 * WARLORDS — Notification catalog (Phase 22: Notification System).
 *
 * THE single server-side registry of every notification the game can emit.
 * Each entry declares:
 *   - the Zod schema that VALIDATES the payload at enqueue time (fail-closed:
 *     a producer cannot enqueue a payload the renderer cannot render),
 *   - the CHANNELS the type is delivered through (IN_APP inbox always; the
 *     Telegram Bot API adds a push channel for time-critical diplomacy and
 *     combat — the adapter is real and env-gated, never a stub),
 *   - the TITLE/BODY template, rendered SERVER-side from the validated
 *     payload only — no client string ever reaches a notification.
 *
 * Engine-ready vs wired: every type below is fully supported by the queue
 * engine (enqueue → dedupe → claim → render → deliver). Types whose source
 * system has not landed yet (Attack, Quest, Clan, World Boss) have their
 * payload contracts and templates finalized HERE so those phases only call
 * `enqueueNotificationInTx` inside their transactions — no notification
 * redesign later. Types with landed producers: CONSTRUCTION_COMPLETE
 * (city), TRAINING_COMPLETE (army), RANK_CHANGE (level-ups + season
 * settlement), REWARD (bootstrap welcome), EVENT (admin event spawn),
 * ANNOUNCEMENT (admin broadcast).
 */

import { z } from 'zod'
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/game/types/common'

// ── Channels ─────────────────────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = ['IN_APP', 'TELEGRAM'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

// ── Policy (worker + retention + API bounds) ─────────────────────────────────

export const NOTIFICATION_POLICY = {
  /** Rows claimed per drain tick. */
  workerBatchSize: 25,
  /** Background worker cadence (ms) — instrumentation-driven runtime. */
  workerTickMs: 15_000,
  /** Processing attempts before a row is parked as FAILED. */
  maxAttempts: 5,
  /** Exponential backoff: base * 2^(attempt-1), capped. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  /** A PROCESSING row older than this is a crashed worker's leak → re-claimable. */
  staleClaimMs: 120_000,
  /** Terminal queue rows + read inbox rows older than this are pruned. */
  retentionDays: 30,
  /** Telegram Bot API HTTP timeout. */
  telegramHttpTimeoutMs: 8_000,
  /** Inbox list bounds. */
  listDefaultLimit: 20,
  listMaxLimit: 50,
  /** Max ids per mark-read call. */
  markReadMaxIds: 100,
  /** Queue ops view: stats window + page size. */
  queueViewLimit: 50,
} as const

/** Backoff before attempt N+1 after failure N (pure — unit-tested). */
export function notificationBackoffDelayMs(attempt: number): number {
  const clamped = Math.max(1, Math.min(attempt, 30))
  const delay = NOTIFICATION_POLICY.backoffBaseMs * 2 ** (clamped - 1)
  return Math.min(delay, NOTIFICATION_POLICY.backoffMaxMs)
}

// ── Payload schemas (validated at enqueue — NEVER client-supplied) ───────────

const shortText = z.string().trim().min(1).max(64)
const idString = z.string().trim().min(1).max(64)

/** RANK_CHANGE covers two real producers: player level-ups and season settlement. */
const rankChangePayload = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LEVEL_UP'),
    level: z.number().int().min(2).max(10_000),
    levelsGained: z.number().int().min(1).max(10_000),
    source: shortText.optional(),
  }),
  z.object({
    kind: z.literal('SEASON_RANK'),
    seasonNumber: z.number().int().min(1).max(100_000),
    rank: z.number().int().min(1).max(10_000_000),
    tier: shortText,
    score: z.number().int().min(0),
    rewardReady: z.boolean(),
  }),
])

export const NOTIFICATION_PAYLOAD_SCHEMAS = {
  ATTACK_INCOMING: z.object({
    marchId: idString,
    attackerName: shortText,
    targetCoord: z.object({
      x: z.number().int().min(0).max(100_000),
      y: z.number().int().min(0).max(100_000),
    }),
    arrivesInSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 3600),
  }),
  ATTACK_RESULT: z.object({
    battleId: idString,
    viewerRole: z.enum(['ATTACKER', 'DEFENDER']),
    outcome: z.enum(['VICTORY', 'DEFEAT', 'DRAW']),
    opponentName: shortText,
    lootSummary: z.string().trim().min(1).max(200).optional(),
  }),
  CONSTRUCTION_COMPLETE: z.object({
    buildingType: idString,
    buildingName: shortText,
    level: z.number().int().min(1).max(1_000),
  }),
  TRAINING_COMPLETE: z.object({
    unitId: idString,
    unitName: shortText,
    count: z.number().int().min(1).max(1_000_000),
  }),
  QUEST_COMPLETED: z.object({
    questId: idString,
    questName: shortText,
    rewardSummary: z.string().trim().min(1).max(200).optional(),
  }),
  REWARD: z.object({
    rewardTitle: z.string().trim().min(4).max(120),
    rewardBody: z.string().trim().min(4).max(280),
  }),
  CLAN_INVITE: z.object({
    invitationId: idString,
    clanId: idString,
    clanName: shortText,
    invitorName: shortText,
  }),
  CLAN_WAR: z.object({
    warId: idString,
    clanName: shortText,
    opponentName: shortText,
    phase: z.enum(['DECLARED', 'STARTED', 'ENDED']),
  }),
  WORLD_BOSS: z.object({
    bossId: idString,
    bossName: shortText,
    phase: z.enum(['SPAWNED', 'ENRAGED', 'DEFEATED', 'ESCAPED']),
  }),
  EVENT: z.object({
    eventId: idString,
    title: z.string().trim().min(4).max(120),
    body: z.string().trim().min(4).max(2000),
  }),
  RANK_CHANGE: rankChangePayload,
  ANNOUNCEMENT: z.object({
    announcementId: idString,
    title: z.string().trim().min(4).max(120),
    body: z.string().trim().min(4).max(2000),
  }),
} as const satisfies Record<NotificationType, z.ZodType>

export type NotificationPayloadMap = {
  [K in NotificationType]: z.output<(typeof NOTIFICATION_PAYLOAD_SCHEMAS)[K]>
}

/** Parse a payload against the type's schema — throws a typed error on mismatch. */
export function validateNotificationPayload<K extends NotificationType>(
  type: K,
  payload: unknown,
): NotificationPayloadMap[K] {
  const schema = NOTIFICATION_PAYLOAD_SCHEMAS[type]
  const result = schema.safeParse(payload)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`Invalid ${type} notification payload — ${issues.join('; ')}`)
  }
  return result.data as NotificationPayloadMap[K]
}

// ── Channels per type ────────────────────────────────────────────────────────

/**
 * Delivery surface per type. Time-critical combat/diplomacy/world notices
 * also push through the Telegram Bot API (the adapter sends a REAL
 * sendMessage call when TELEGRAM_BOT_TOKEN is configured; delivery is
 * honestly marked SKIPPED otherwise — never a fake success).
 */
export const NOTIFICATION_TYPE_CHANNELS: Record<NotificationType, readonly NotificationChannel[]> =
  {
    ATTACK_INCOMING: ['IN_APP', 'TELEGRAM'],
    ATTACK_RESULT: ['IN_APP', 'TELEGRAM'],
    CONSTRUCTION_COMPLETE: ['IN_APP'],
    TRAINING_COMPLETE: ['IN_APP'],
    QUEST_COMPLETED: ['IN_APP'],
    REWARD: ['IN_APP'],
    CLAN_INVITE: ['IN_APP', 'TELEGRAM'],
    CLAN_WAR: ['IN_APP', 'TELEGRAM'],
    WORLD_BOSS: ['IN_APP', 'TELEGRAM'],
    EVENT: ['IN_APP', 'TELEGRAM'],
    RANK_CHANGE: ['IN_APP'],
    ANNOUNCEMENT: ['IN_APP'],
  }

// ── Server-side rendering (validated payload → title/body) ───────────────────

export interface RenderedNotification {
  title: string
  body: string
}

export function renderNotification<K extends NotificationType>(
  type: K,
  payload: NotificationPayloadMap[K],
): RenderedNotification {
  switch (type) {
    case 'ATTACK_INCOMING': {
      const p = payload as NotificationPayloadMap['ATTACK_INCOMING']
      return {
        title: `Attack incoming from ${p.attackerName}`,
        body: `Enemy forces are marching on your city (${p.targetCoord.x},${p.targetCoord.y}) — arrival in ~${p.arrivesInSeconds}s.`,
      }
    }
    case 'ATTACK_RESULT': {
      const p = payload as NotificationPayloadMap['ATTACK_RESULT']
      const outcome =
        p.outcome === 'VICTORY' ? 'Victory' : p.outcome === 'DEFEAT' ? 'Defeat' : 'Stalemate'
      const side = p.viewerRole === 'ATTACKER' ? 'attack on' : 'defense of'
      const loot = p.lootSummary ? ` ${p.lootSummary}` : ''
      return {
        title: `Battle report — ${outcome}`,
        body: `Your ${side} ${p.opponentName} ended in ${outcome.toLowerCase()}.${loot}`,
      }
    }
    case 'CONSTRUCTION_COMPLETE': {
      const p = payload as NotificationPayloadMap['CONSTRUCTION_COMPLETE']
      return {
        title: `${p.buildingName} upgraded`,
        body: `${p.buildingName} reached level ${p.level}.`,
      }
    }
    case 'TRAINING_COMPLETE': {
      const p = payload as NotificationPayloadMap['TRAINING_COMPLETE']
      return {
        title: `${p.unitName} training complete`,
        body: `${p.count} ${p.unitName}${p.count === 1 ? '' : 's'} joined your army.`,
      }
    }
    case 'QUEST_COMPLETED': {
      const p = payload as NotificationPayloadMap['QUEST_COMPLETED']
      return {
        title: `Quest complete — ${p.questName}`,
        body: p.rewardSummary
          ? `${p.questName} is done. ${p.rewardSummary}`
          : `${p.questName} is done.`,
      }
    }
    case 'REWARD': {
      const p = payload as NotificationPayloadMap['REWARD']
      return { title: p.rewardTitle, body: p.rewardBody }
    }
    case 'CLAN_INVITE': {
      const p = payload as NotificationPayloadMap['CLAN_INVITE']
      return {
        title: `Invitation to ${p.clanName}`,
        body: `${p.invitorName} invites you to join ${p.clanName}.`,
      }
    }
    case 'CLAN_WAR': {
      const p = payload as NotificationPayloadMap['CLAN_WAR']
      const phase =
        p.phase === 'DECLARED'
          ? 'declared on your clan'
          : p.phase === 'STARTED'
            ? 'has begun'
            : 'has ended'
      return {
        title: `Clan war ${p.phase.toLowerCase().replace('_', ' ')}`,
        body: `War between ${p.clanName} and ${p.opponentName} ${phase}.`,
      }
    }
    case 'WORLD_BOSS': {
      const p = payload as NotificationPayloadMap['WORLD_BOSS']
      const phase =
        p.phase === 'SPAWNED'
          ? 'has spawned'
          : p.phase === 'ENRAGED'
            ? 'is enraged'
            : p.phase === 'DEFEATED'
              ? 'has been slain'
              : 'has escaped'
      return {
        title: `World boss: ${p.bossName}`,
        body: `${p.bossName} ${phase}. Rally your forces.`,
      }
    }
    case 'EVENT': {
      const p = payload as NotificationPayloadMap['EVENT']
      return { title: p.title, body: p.body }
    }
    case 'RANK_CHANGE': {
      const p = payload as NotificationPayloadMap['RANK_CHANGE']
      if (p.kind === 'LEVEL_UP') {
        return {
          title: `Level ${p.level} reached`,
          body: `You have grown stronger — level ${p.level}${p.source ? ` (${p.source})` : ''}.`,
        }
      }
      return {
        title: `Season ${p.seasonNumber} finished — rank #${p.rank}`,
        body: `${p.tier} · ${p.score} season points.${p.rewardReady ? ' Your reward is ready to claim.' : ''}`,
      }
    }
    case 'ANNOUNCEMENT': {
      const p = payload as NotificationPayloadMap['ANNOUNCEMENT']
      return { title: p.title, body: p.body }
    }
  }
}

// ── Dedupe keys — the EVENT IDENTITY, not the entity id ──────────────────────
// A building re-upgrades, a player re-levels: the same ENTITY may notify
// again for a DIFFERENT event. The key captures the specific occurrence so
// retries can never duplicate a notification, while genuinely new events
// always pass.

export const notificationDedupeKeys = {
  attackIncoming: (marchId: string, defenderPlayerId: string) =>
    `attack_in:${marchId}:${defenderPlayerId}`,
  attackResult: (battleId: string, viewerPlayerId: string) =>
    `battle:${battleId}:${viewerPlayerId}`,
  construction: (buildingId: string, level: number) => `construction:${buildingId}:${level}`,
  training: (queueItemId: string) => `training:${queueItemId}`,
  quest: (playerId: string, questId: string) => `quest:${playerId}:${questId}`,
  clanInvite: (invitationId: string) => `clan_invite:${invitationId}`,
  clanWar: (warId: string, phase: string) => `clan_war:${warId}:${phase}`,
  worldBoss: (bossId: string, phase: string) => `world_boss:${bossId}:${phase}`,
  event: (eventId: string) => `event:${eventId}`,
  levelUp: (playerId: string, level: number) => `level_up:${playerId}:${level}`,
  seasonRank: (seasonId: string, playerId: string) => `season_rank:${seasonId}:${playerId}`,
  welcome: (playerId: string) => `welcome:${playerId}`,
  announcement: (announcementId: string) => `announcement:${announcementId}`,
} as const

// ── Invariants (unit-tested) ─────────────────────────────────────────────────

export function validateNotificationCatalog(): string[] {
  const problems: string[] = []
  const catalogTypes = Object.keys(NOTIFICATION_PAYLOAD_SCHEMAS) as NotificationType[]
  if (catalogTypes.length !== NOTIFICATION_TYPES.length) {
    problems.push('catalog type count diverges from NOTIFICATION_TYPES')
  }
  for (const type of NOTIFICATION_TYPES) {
    if (!(type in NOTIFICATION_PAYLOAD_SCHEMAS)) problems.push(`${type}: missing payload schema`)
    if (!(type in NOTIFICATION_TYPE_CHANNELS)) problems.push(`${type}: missing channel list`)
    else {
      const channels = NOTIFICATION_TYPE_CHANNELS[type]
      if (channels.length === 0) problems.push(`${type}: empty channel list`)
      if (!channels.includes('IN_APP')) problems.push(`${type}: IN_APP is mandatory`)
      for (const channel of channels) {
        if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
          problems.push(`${type}: unknown channel ${channel}`)
        }
      }
    }
  }
  // Dedupe keys must produce bounded, collision-free strings.
  for (const builder of Object.values(notificationDedupeKeys)) {
    const sample = (builder as (...args: unknown[]) => string)('x', 1, 'y')
    if (sample.length === 0 || sample.length > 200)
      problems.push(`dedupe key builder emits unbounded key: ${sample}`)
  }
  return problems
}
