-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "photoUrl" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "bannedAt" TIMESTAMP(3),
    "banExpiresAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "initDataHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "telegramAuthDate" TIMESTAMP(3) NOT NULL,
    "issuedIp" TEXT,
    "userAgent" TEXT,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "power" BIGINT NOT NULL DEFAULT 0,
    "honor" BIGINT NOT NULL DEFAULT 0,
    "reputation" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "reputationScore" INTEGER NOT NULL DEFAULT 0,
    "gems" BIGINT NOT NULL DEFAULT 0,
    "energy" INTEGER NOT NULL DEFAULT 100,
    "energyUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seasonPoints" INTEGER NOT NULL DEFAULT 0,
    "activeTitleId" TEXT,
    "stats" JSONB,
    "clanId" TEXT,
    "clanRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gold" BIGINT NOT NULL DEFAULT 0,
    "wood" BIGINT NOT NULL DEFAULT 0,
    "iron" BIGINT NOT NULL DEFAULT 0,
    "food" BIGINT NOT NULL DEFAULT 0,
    "crystal" BIGINT NOT NULL DEFAULT 0,
    "capacityUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_transactions" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isConstructing" BOOLEAN NOT NULL DEFAULT false,
    "upgradeStartedAt" TIMESTAMP(3),
    "upgradeCompletesAt" TIMESTAMP(3),
    "pendingLevel" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "attack" INTEGER NOT NULL,
    "defense" INTEGER NOT NULL,
    "health" INTEGER NOT NULL,
    "speed" INTEGER NOT NULL,
    "foodUpkeep" INTEGER NOT NULL,
    "carryCapacity" INTEGER NOT NULL DEFAULT 0,
    "trainingCost" JSONB NOT NULL,
    "trainingTimeSec" INTEGER NOT NULL,
    "trainingBuilding" TEXT NOT NULL,
    "requiredBuildingLevel" INTEGER NOT NULL DEFAULT 1,
    "strongAgainst" JSONB,
    "weakAgainst" JSONB,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_units" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_queue_items" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completesAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRAINING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marches" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "targetPlayerId" TEXT,
    "territoryId" TEXT,
    "bossId" TEXT,
    "type" TEXT NOT NULL,
    "units" JSONB NOT NULL,
    "departedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivesAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EN_ROUTE',
    "battleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commanders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "baseStats" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "passive" JSONB NOT NULL,
    "lore" TEXT,
    "isSeasonal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commanders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_commanders" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "commanderId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_commanders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "effects" JSONB,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "basePrice" BIGINT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commander_equipment" (
    "id" TEXT NOT NULL,
    "playerCommanderId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "equippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commander_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technologies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "maxLevel" INTEGER NOT NULL DEFAULT 1,
    "prerequisites" JSONB,
    "costPerLevel" JSONB NOT NULL,
    "effectsPerLevel" JSONB NOT NULL,
    "researchTimeSecPerLevel" INTEGER NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technologies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_technologies" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "technologyId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "researching" BOOLEAN NOT NULL DEFAULT false,
    "researchCompletesAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_technologies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territories" (
    "id" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "ownerPlayerId" TEXT,
    "cityId" TEXT,
    "defenseStrength" INTEGER NOT NULL DEFAULT 0,
    "production" JSONB,
    "strategicValue" INTEGER NOT NULL DEFAULT 0,
    "lastCapturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battles" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "attackerPlayerId" TEXT NOT NULL,
    "defenderPlayerId" TEXT,
    "territoryId" TEXT,
    "bossId" TEXT,
    "marchId" TEXT,
    "result" TEXT NOT NULL,
    "attackerPower" BIGINT NOT NULL DEFAULT 0,
    "defenderPower" BIGINT NOT NULL DEFAULT 0,
    "roundsCount" INTEGER NOT NULL DEFAULT 0,
    "loot" JSONB,
    "honorDelta" INTEGER NOT NULL DEFAULT 0,
    "reputationDelta" INTEGER NOT NULL DEFAULT 0,
    "energySpent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "battles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battle_rounds" (
    "id" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "unitsCommitted" JSONB NOT NULL,
    "unitsLost" JSONB NOT NULL,
    "damageDealt" BIGINT NOT NULL DEFAULT 0,
    "events" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "battle_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battle_logs" (
    "id" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "battle_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scout_reports" (
    "id" TEXT NOT NULL,
    "attackerPlayerId" TEXT NOT NULL,
    "targetPlayerId" TEXT,
    "territoryId" TEXT,
    "data" JSONB NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quests" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "objectiveType" TEXT NOT NULL,
    "objectiveTarget" JSONB NOT NULL,
    "reward" JSONB NOT NULL,
    "prerequisiteQuestIds" JSONB,
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "cooldownHours" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_quests" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_quests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "target" INTEGER NOT NULL DEFAULT 1,
    "reward" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_achievements" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "description" TEXT,
    "emblemUrl" TEXT,
    "leaderPlayerId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "trophies" INTEGER NOT NULL DEFAULT 0,
    "memberCount" INTEGER NOT NULL DEFAULT 1,
    "treasury" JSONB,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clan_members" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "contribution" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clan_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clan_invitations" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clan_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clan_messages" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "senderPlayerId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clan_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clan_wars" (
    "id" TEXT NOT NULL,
    "attackerClanId" TEXT NOT NULL,
    "defenderClanId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DECLARED',
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "scoreAttacker" INTEGER NOT NULL DEFAULT 0,
    "scoreDefender" INTEGER NOT NULL DEFAULT 0,
    "winnerClanId" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clan_wars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clan_war_participations" (
    "id" TEXT NOT NULL,
    "warId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "battles" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "clan_war_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_orders" (
    "id" TEXT NOT NULL,
    "sellerPlayerId" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'SELL',
    "itemId" TEXT,
    "resource" TEXT,
    "unitPrice" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "market_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_transactions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerPlayerId" TEXT NOT NULL,
    "sellerPlayerId" TEXT NOT NULL,
    "itemId" TEXT,
    "resource" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPCOMING',
    "settledAt" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_reward_claims" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "tierName" TEXT NOT NULL,
    "rewards" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_wallets" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "shards" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cosmetics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_cosmetics" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "acquiredSeason" INTEGER,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "titles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_titles" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "acquiredSeason" INTEGER,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboards" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT,
    "category" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "rewards" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_bosses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxHp" BIGINT NOT NULL,
    "currentHp" BIGINT NOT NULL,
    "spawnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SPAWNED',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "world_bosses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_boss_damages" (
    "id" TEXT NOT NULL,
    "bossId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "damage" BIGINT NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "world_boss_damages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "targetPlayerId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "config" JSONB,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "deliveredVia" TEXT NOT NULL DEFAULT 'IN_APP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "clanId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_queue" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "lastError" TEXT,
    "notificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "permissions" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diplomacy_relations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "diplomacy_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spy_missions" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "targetPlayerId" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "successChance" INTEGER NOT NULL,
    "success" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completesAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,

    CONSTRAINT "spy_missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "playerId" TEXT,
    "action" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_initDataHash_key" ON "auth_sessions"("initDataHash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_tokenHash_key" ON "auth_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_expiresAt_idx" ON "auth_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "players_userId_key" ON "players"("userId");

-- CreateIndex
CREATE INDEX "players_power_idx" ON "players"("power");

-- CreateIndex
CREATE INDEX "players_honor_idx" ON "players"("honor");

-- CreateIndex
CREATE INDEX "players_clanId_idx" ON "players"("clanId");

-- CreateIndex
CREATE INDEX "players_seasonPoints_idx" ON "players"("seasonPoints");

-- CreateIndex
CREATE INDEX "players_name_idx" ON "players"("name");

-- CreateIndex
CREATE UNIQUE INDEX "resources_playerId_key" ON "resources"("playerId");

-- CreateIndex
CREATE INDEX "resource_transactions_playerId_createdAt_idx" ON "resource_transactions"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "resource_transactions_playerId_reason_idx" ON "resource_transactions"("playerId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "cities_playerId_key" ON "cities"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "cities_x_y_key" ON "cities"("x", "y");

-- CreateIndex
CREATE INDEX "buildings_upgradeCompletesAt_idx" ON "buildings"("upgradeCompletesAt");

-- CreateIndex
CREATE UNIQUE INDEX "buildings_cityId_type_key" ON "buildings"("cityId", "type");

-- CreateIndex
CREATE INDEX "units_class_tier_idx" ON "units"("class", "tier");

-- CreateIndex
CREATE INDEX "player_units_unitId_idx" ON "player_units"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "player_units_playerId_unitId_key" ON "player_units"("playerId", "unitId");

-- CreateIndex
CREATE INDEX "training_queue_items_playerId_completesAt_idx" ON "training_queue_items"("playerId", "completesAt");

-- CreateIndex
CREATE INDEX "training_queue_items_playerId_status_idx" ON "training_queue_items"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "marches_battleId_key" ON "marches"("battleId");

-- CreateIndex
CREATE INDEX "marches_arrivesAt_status_idx" ON "marches"("arrivesAt", "status");

-- CreateIndex
CREATE INDEX "marches_playerId_status_idx" ON "marches"("playerId", "status");

-- CreateIndex
CREATE INDEX "marches_territoryId_idx" ON "marches"("territoryId");

-- CreateIndex
CREATE UNIQUE INDEX "player_commanders_playerId_commanderId_key" ON "player_commanders"("playerId", "commanderId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_playerId_itemId_key" ON "inventory"("playerId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "commander_equipment_playerCommanderId_slot_key" ON "commander_equipment"("playerCommanderId", "slot");

-- CreateIndex
CREATE INDEX "technologies_branch_tier_idx" ON "technologies"("branch", "tier");

-- CreateIndex
CREATE INDEX "player_technologies_researchCompletesAt_idx" ON "player_technologies"("researchCompletesAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_technologies_playerId_technologyId_key" ON "player_technologies"("playerId", "technologyId");

-- CreateIndex
CREATE UNIQUE INDEX "territories_cityId_key" ON "territories"("cityId");

-- CreateIndex
CREATE INDEX "territories_ownerPlayerId_idx" ON "territories"("ownerPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "territories_x_y_key" ON "territories"("x", "y");

-- CreateIndex
CREATE UNIQUE INDEX "battles_marchId_key" ON "battles"("marchId");

-- CreateIndex
CREATE INDEX "battles_attackerPlayerId_createdAt_idx" ON "battles"("attackerPlayerId", "createdAt");

-- CreateIndex
CREATE INDEX "battles_defenderPlayerId_createdAt_idx" ON "battles"("defenderPlayerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "battle_rounds_battleId_roundNumber_side_key" ON "battle_rounds"("battleId", "roundNumber", "side");

-- CreateIndex
CREATE INDEX "battle_logs_playerId_createdAt_idx" ON "battle_logs"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "scout_reports_attackerPlayerId_createdAt_idx" ON "scout_reports"("attackerPlayerId", "createdAt");

-- CreateIndex
CREATE INDEX "scout_reports_targetPlayerId_expiresAt_idx" ON "scout_reports"("targetPlayerId", "expiresAt");

-- CreateIndex
CREATE INDEX "quests_type_sortOrder_idx" ON "quests"("type", "sortOrder");

-- CreateIndex
CREATE INDEX "player_quests_playerId_status_idx" ON "player_quests"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "player_achievements_playerId_achievementId_key" ON "player_achievements"("playerId", "achievementId");

-- CreateIndex
CREATE UNIQUE INDEX "clans_name_key" ON "clans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "clans_tag_key" ON "clans"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "clan_members_playerId_key" ON "clan_members"("playerId");

-- CreateIndex
CREATE INDEX "clan_members_clanId_idx" ON "clan_members"("clanId");

-- CreateIndex
CREATE INDEX "clan_invitations_playerId_status_idx" ON "clan_invitations"("playerId", "status");

-- CreateIndex
CREATE INDEX "clan_messages_clanId_createdAt_idx" ON "clan_messages"("clanId", "createdAt");

-- CreateIndex
CREATE INDEX "clan_wars_status_endsAt_idx" ON "clan_wars"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "clan_war_participations_warId_playerId_key" ON "clan_war_participations"("warId", "playerId");

-- CreateIndex
CREATE INDEX "market_orders_status_createdAt_idx" ON "market_orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "market_transactions_buyerPlayerId_createdAt_idx" ON "market_transactions"("buyerPlayerId", "createdAt");

-- CreateIndex
CREATE INDEX "market_transactions_sellerPlayerId_createdAt_idx" ON "market_transactions"("sellerPlayerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_number_key" ON "seasons"("number");

-- CreateIndex
CREATE INDEX "seasons_status_endsAt_idx" ON "seasons"("status", "endsAt");

-- CreateIndex
CREATE INDEX "season_reward_claims_playerId_claimedAt_idx" ON "season_reward_claims"("playerId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "season_reward_claims_seasonId_playerId_key" ON "season_reward_claims"("seasonId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "season_wallets_seasonId_playerId_key" ON "season_wallets"("seasonId", "playerId");

-- CreateIndex
CREATE INDEX "player_cosmetics_playerId_unlockedAt_idx" ON "player_cosmetics"("playerId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_cosmetics_playerId_cosmeticId_key" ON "player_cosmetics"("playerId", "cosmeticId");

-- CreateIndex
CREATE INDEX "player_titles_playerId_unlockedAt_idx" ON "player_titles"("playerId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "player_titles_playerId_titleId_key" ON "player_titles"("playerId", "titleId");

-- CreateIndex
CREATE INDEX "leaderboards_category_period_rank_idx" ON "leaderboards"("category", "period", "rank");

-- CreateIndex
CREATE INDEX "leaderboards_seasonId_idx" ON "leaderboards"("seasonId");

-- CreateIndex
CREATE INDEX "world_boss_damages_bossId_damage_idx" ON "world_boss_damages"("bossId", "damage");

-- CreateIndex
CREATE UNIQUE INDEX "world_boss_damages_bossId_playerId_key" ON "world_boss_damages"("bossId", "playerId");

-- CreateIndex
CREATE INDEX "events_status_endsAt_idx" ON "events"("status", "endsAt");

-- CreateIndex
CREATE INDEX "events_targetPlayerId_idx" ON "events"("targetPlayerId");

-- CreateIndex
CREATE INDEX "notifications_playerId_isRead_createdAt_idx" ON "notifications"("playerId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "notification_queue_status_availableAt_idx" ON "notification_queue"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notification_queue_playerId_createdAt_idx" ON "notification_queue"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_queue_playerId_type_dedupeKey_key" ON "notification_queue"("playerId", "type", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_userId_key" ON "admin_users"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "diplomacy_relations_kind_sourceId_targetId_key" ON "diplomacy_relations"("kind", "sourceId", "targetId");

-- CreateIndex
CREATE INDEX "spy_missions_playerId_status_idx" ON "spy_missions"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_activeTitleId_fkey" FOREIGN KEY ("activeTitleId") REFERENCES "titles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_transactions" ADD CONSTRAINT "resource_transactions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cities" ADD CONSTRAINT "cities_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_units" ADD CONSTRAINT "player_units_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_units" ADD CONSTRAINT "player_units_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_queue_items" ADD CONSTRAINT "training_queue_items_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_queue_items" ADD CONSTRAINT "training_queue_items_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marches" ADD CONSTRAINT "marches_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marches" ADD CONSTRAINT "marches_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marches" ADD CONSTRAINT "marches_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marches" ADD CONSTRAINT "marches_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_commanders" ADD CONSTRAINT "player_commanders_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_commanders" ADD CONSTRAINT "player_commanders_commanderId_fkey" FOREIGN KEY ("commanderId") REFERENCES "commanders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commander_equipment" ADD CONSTRAINT "commander_equipment_playerCommanderId_fkey" FOREIGN KEY ("playerCommanderId") REFERENCES "player_commanders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commander_equipment" ADD CONSTRAINT "commander_equipment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_technologies" ADD CONSTRAINT "player_technologies_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_technologies" ADD CONSTRAINT "player_technologies_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "technologies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_ownerPlayerId_fkey" FOREIGN KEY ("ownerPlayerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "territories" ADD CONSTRAINT "territories_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_attackerPlayerId_fkey" FOREIGN KEY ("attackerPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_defenderPlayerId_fkey" FOREIGN KEY ("defenderPlayerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_bossId_fkey" FOREIGN KEY ("bossId") REFERENCES "world_bosses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_rounds" ADD CONSTRAINT "battle_rounds_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_logs" ADD CONSTRAINT "battle_logs_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_logs" ADD CONSTRAINT "battle_logs_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_attackerPlayerId_fkey" FOREIGN KEY ("attackerPlayerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_reports" ADD CONSTRAINT "scout_reports_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_quests" ADD CONSTRAINT "player_quests_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_quests" ADD CONSTRAINT "player_quests_questId_fkey" FOREIGN KEY ("questId") REFERENCES "quests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clans" ADD CONSTRAINT "clans_leaderPlayerId_fkey" FOREIGN KEY ("leaderPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_invitations" ADD CONSTRAINT "clan_invitations_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_invitations" ADD CONSTRAINT "clan_invitations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_invitations" ADD CONSTRAINT "clan_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_messages" ADD CONSTRAINT "clan_messages_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_messages" ADD CONSTRAINT "clan_messages_senderPlayerId_fkey" FOREIGN KEY ("senderPlayerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_attackerClanId_fkey" FOREIGN KEY ("attackerClanId") REFERENCES "clans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_defenderClanId_fkey" FOREIGN KEY ("defenderClanId") REFERENCES "clans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_winnerClanId_fkey" FOREIGN KEY ("winnerClanId") REFERENCES "clans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_war_participations" ADD CONSTRAINT "clan_war_participations_warId_fkey" FOREIGN KEY ("warId") REFERENCES "clan_wars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clan_war_participations" ADD CONSTRAINT "clan_war_participations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_sellerPlayerId_fkey" FOREIGN KEY ("sellerPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_transactions" ADD CONSTRAINT "market_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "market_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_transactions" ADD CONSTRAINT "market_transactions_buyerPlayerId_fkey" FOREIGN KEY ("buyerPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_transactions" ADD CONSTRAINT "market_transactions_sellerPlayerId_fkey" FOREIGN KEY ("sellerPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_reward_claims" ADD CONSTRAINT "season_reward_claims_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_reward_claims" ADD CONSTRAINT "season_reward_claims_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_wallets" ADD CONSTRAINT "season_wallets_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_wallets" ADD CONSTRAINT "season_wallets_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_cosmetics" ADD CONSTRAINT "player_cosmetics_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_cosmetics" ADD CONSTRAINT "player_cosmetics_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "cosmetics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_titles" ADD CONSTRAINT "player_titles_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_titles" ADD CONSTRAINT "player_titles_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "titles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_boss_damages" ADD CONSTRAINT "world_boss_damages_bossId_fkey" FOREIGN KEY ("bossId") REFERENCES "world_bosses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_boss_damages" ADD CONSTRAINT "world_boss_damages_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spy_missions" ADD CONSTRAINT "spy_missions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spy_missions" ADD CONSTRAINT "spy_missions_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

