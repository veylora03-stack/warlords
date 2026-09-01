/**
 * WARLORDS — Quest feature types (mirror of the server DTOs).
 *
 * These mirror src/lib/game/services/quest.service.ts and
 * achievement.service.ts read models exactly; nothing here is authoritative —
 * progress, eligibility, status transitions and rewards are all
 * server-computed and arrive read-only through the REST envelope.
 * Reward amounts cross as JSON numbers (server catalog values); wallet
 * balances in claim results cross as strings (BigInt policy).
 */

export type QuestType = 'MAIN' | 'DAILY' | 'WEEKLY' | 'SEASONAL'

export type QuestStatus = 'ACTIVE' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED'

export type QuestFilter = 'all' | 'active' | 'completed' | 'claimable'

export type QuestIneligibilityReason =
  'INACTIVE' | 'MIN_LEVEL' | 'PREREQUISITES' | 'NO_ACTIVE_SEASON'

export interface QuestInstanceView {
  instanceId: string
  cycle: string
  status: QuestStatus
  progress: number
  target: number
  claimable: boolean
  assignedAt: string
  expiresAt: string | null
  completedAt: string | null
  claimedAt: string | null
}

export interface QuestBoardEntry {
  id: string
  type: QuestType
  title: string
  description: string
  objectiveType: string
  objectiveTarget: Record<string, unknown>
  reward: Record<string, number>
  minLevel: number
  prerequisiteQuestIds: string[]
  sortOrder: number
  /** Present when the player holds an instance for the quest's current cycle. */
  instance: QuestInstanceView | null
  /** Server-side eligibility verdict for this cycle (locked quests show why). */
  eligibility: { eligible: true } | { eligible: false; reason: QuestIneligibilityReason }
}

export interface QuestBoardCounts {
  active: number
  completed: number
  claimable: number
  claimed: number
  expired: number
}

export interface QuestBoardView {
  quests: QuestBoardEntry[]
  counts: QuestBoardCounts
  filter: QuestFilter
}

export interface QuestClaimResult {
  questId: string
  title: string
  cycle: string
  reward: Record<string, number>
  /** Post-claim wallet balances — strings (BigInt policy), display only. */
  wallet: Record<string, string>
}

export interface AchievementProgress {
  current: number
  target: number
  complete: boolean
}

export interface AchievementView {
  id: string
  title: string
  description: string
  category: string
  metric: string
  target: number
  reward: Record<string, number>
  /** Live progress where the metric is player-visible; null otherwise. */
  progress: AchievementProgress | null
  unlocked: boolean
  unlockedAt: string | null
}

export interface AchievementBoardView {
  achievements: AchievementView[]
}
