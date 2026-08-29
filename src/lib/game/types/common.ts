/**
 * WARLORDS — Common domain enumerations & primitives.
 *
 * These are the application-layer authority for all enum-like values.
 * The database stores them as strings (Prisma enums are unsupported on SQLite);
 * every write path validates against these types via Zod schemas built from them.
 *
 * Numeric policy: percentages/ratios are BASIS POINTS (bps): 1000 bps = +10%.
 * Never use floating point for economy math.
 */

// ── Resources ────────────────────────────────────────────────────────────────

export const RESOURCES = ['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL'] as const
export type Resource = (typeof RESOURCES)[number]

/** Premium + action currencies tracked on Player rather than the wallet. */
export const SPECIAL_CURRENCIES = ['GEMS', 'ENERGY'] as const
export type SpecialCurrency = (typeof SPECIAL_CURRENCIES)[number]

export type LedgerResource = Resource | SpecialCurrency

// ── Units ────────────────────────────────────────────────────────────────────

export const UNIT_CLASSES = ['INFANTRY', 'RANGED', 'CAVALRY', 'SIEGE'] as const
export type UnitClass = (typeof UNIT_CLASSES)[number]

/** Data-driven counter relationships live in unit config (`strongAgainst`/`weakAgainst`). */
export interface CounterRule {
  unitTypeId: string
  bonusBps: number
  penaltyBps: number
}

// ── Rarity ───────────────────────────────────────────────────────────────────

export const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'] as const
export type Rarity = (typeof RARITIES)[number]

// ── Buildings ────────────────────────────────────────────────────────────────

export const BUILDING_TYPES = [
  'TOWN_HALL',
  'CASTLE',
  'BARRACKS',
  'ARCHER_CAMP',
  'STABLE',
  'ARMORY',
  'HOSPITAL',
  'FARM',
  'WOOD_MILL',
  'IRON_MINE',
  'GOLD_MINE',
  'ACADEMY',
  'SCOUT_CENTER',
  'SPY_CENTER',
  'WAREHOUSE',
  'MARKET',
  'WALL',
] as const
export type BuildingType = (typeof BUILDING_TYPES)[number]

// ── Technology ───────────────────────────────────────────────────────────────

export const TECH_BRANCHES = ['MILITARY', 'ECONOMY', 'DEFENSE', 'SCIENCE', 'SCOUTING'] as const
export type TechBranch = (typeof TECH_BRANCHES)[number]

// ── Quests ───────────────────────────────────────────────────────────────────

export const QUEST_TYPES = ['MAIN', 'DAILY', 'WEEKLY', 'ACHIEVEMENT', 'CLAN', 'EVENT'] as const
export type QuestType = (typeof QUEST_TYPES)[number]

export const QUEST_STATUSES = ['ACTIVE', 'COMPLETED', 'CLAIMED', 'EXPIRED'] as const
export type QuestStatus = (typeof QUEST_STATUSES)[number]

// ── Reputation ───────────────────────────────────────────────────────────────

export const REPUTATION_LEVELS = ['HONORABLE', 'TRUSTED', 'NEUTRAL', 'DANGEROUS', 'RUTHLESS', 'TYRANT'] as const
export type ReputationLevel = (typeof REPUTATION_LEVELS)[number]

// ── Clan ─────────────────────────────────────────────────────────────────────

export const CLAN_ROLES = ['LEADER', 'OFFICER', 'MEMBER'] as const
export type ClanRole = (typeof CLAN_ROLES)[number]

// ── Items & equipment ────────────────────────────────────────────────────────

export const EQUIPMENT_SLOTS = ['WEAPON', 'ARMOR', 'HELMET', 'RING', 'AMULET'] as const
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number]

export const ITEM_SLOTS = [...EQUIPMENT_SLOTS, 'CONSUMABLE', 'CHEST'] as const
export type ItemSlot = (typeof ITEM_SLOTS)[number]

// ── World & territory ────────────────────────────────────────────────────────

export const TERRITORY_TYPES = [
  'PLAYER_CITY',
  'NPC_VILLAGE',
  'RESOURCE_ZONE',
  'MINE',
  'FOREST',
  'MOUNTAIN',
  'BOSS_ZONE',
  'SPECIAL',
] as const
export type TerritoryType = (typeof TERRITORY_TYPES)[number]

// ── Battles & marches ────────────────────────────────────────────────────────

export const BATTLE_TYPES = ['PVP_ATTACK', 'PVE', 'TERRITORY_ASSAULT', 'SCOUT', 'BOSS_RAID'] as const
export type BattleType = (typeof BATTLE_TYPES)[number]

export const BATTLE_RESULTS = ['ATTACKER_WIN', 'DEFENDER_WIN', 'DRAW'] as const
export type BattleResult = (typeof BATTLE_RESULTS)[number]

export const MARCH_TYPES = ['ATTACK', 'SCOUT', 'REINFORCE', 'RETURN'] as const
export type MarchType = (typeof MARCH_TYPES)[number]

export const MARCH_STATUSES = ['EN_ROUTE', 'RESOLVING', 'RETURNING', 'ARRIVED', 'CANCELLED'] as const
export type MarchStatus = (typeof MARCH_STATUSES)[number]

// ── Events ───────────────────────────────────────────────────────────────────

export const GAME_EVENT_TYPES = [
  'GOLD_RUSH',
  'BANDIT_ATTACK',
  'PLAGUE',
  'FIRE',
  'MERCHANT_FLEET',
  'RARE_METEOR',
  'NPC_INVASION',
] as const
export type GameEventType = (typeof GAME_EVENT_TYPES)[number]

// ── Notifications ────────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  'ATTACK_INCOMING',
  'ATTACK_RESULT',
  'CONSTRUCTION_COMPLETE',
  'TRAINING_COMPLETE',
  'QUEST_COMPLETED',
  'REWARD',
  'CLAN_INVITE',
  'CLAN_WAR',
  'WORLD_BOSS',
  'EVENT',
  'RANK_CHANGE',
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

// ── Access control ───────────────────────────────────────────────────────────

export const USER_ROLES = ['USER', 'ADMIN', 'SUPERADMIN'] as const
export type UserRole = (typeof USER_ROLES)[number]

// ── Shared primitives ────────────────────────────────────────────────────────

export interface Coordinate {
  x: number
  y: number
}

/** Game content snapshot version — stored on battles so replays stay exact. */
export const CONFIG_VERSION = 1
