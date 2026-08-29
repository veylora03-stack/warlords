-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "photoUrl" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "bannedAt" DATETIME,
    "banExpiresAt" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "energyUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seasonPoints" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB,
    "clanId" TEXT,
    "clanRole" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "players_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "gold" BIGINT NOT NULL DEFAULT 0,
    "wood" BIGINT NOT NULL DEFAULT 0,
    "iron" BIGINT NOT NULL DEFAULT 0,
    "food" BIGINT NOT NULL DEFAULT 0,
    "crystal" BIGINT NOT NULL DEFAULT 0,
    "capacityUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "resources_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "resource_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resource_transactions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cities_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isConstructing" BOOLEAN NOT NULL DEFAULT false,
    "upgradeStartedAt" DATETIME,
    "upgradeCompletesAt" DATETIME,
    "pendingLevel" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "buildings_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "strongAgainst" JSONB,
    "weakAgainst" JSONB,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "player_units_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_units_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "training_queue_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completesAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRAINING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "training_queue_items_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "training_queue_items_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "marches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "targetPlayerId" TEXT,
    "territoryId" TEXT,
    "bossId" TEXT,
    "type" TEXT NOT NULL,
    "units" JSONB NOT NULL,
    "departedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivesAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EN_ROUTE',
    "battleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "marches_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "marches_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "marches_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "marches_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "commanders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rarity" TEXT NOT NULL,
    "baseStats" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "passive" JSONB NOT NULL,
    "lore" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_commanders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "commanderId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "unlockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "player_commanders_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_commanders_commanderId_fkey" FOREIGN KEY ("commanderId") REFERENCES "commanders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inventory_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "commander_equipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerCommanderId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "equippedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "commander_equipment_playerCommanderId_fkey" FOREIGN KEY ("playerCommanderId") REFERENCES "player_commanders" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "commander_equipment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "technologies" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_technologies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "technologyId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "researching" BOOLEAN NOT NULL DEFAULT false,
    "researchCompletesAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "player_technologies_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_technologies_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "technologies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "territories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "ownerPlayerId" TEXT,
    "cityId" TEXT,
    "defenseStrength" INTEGER NOT NULL DEFAULT 0,
    "production" JSONB,
    "strategicValue" INTEGER NOT NULL DEFAULT 0,
    "lastCapturedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "territories_ownerPlayerId_fkey" FOREIGN KEY ("ownerPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "territories_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "battles" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "battles_attackerPlayerId_fkey" FOREIGN KEY ("attackerPlayerId") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "battles_defenderPlayerId_fkey" FOREIGN KEY ("defenderPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "battles_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "battles_bossId_fkey" FOREIGN KEY ("bossId") REFERENCES "world_bosses" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "battle_rounds" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "battleId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "unitsCommitted" JSONB NOT NULL,
    "unitsLost" JSONB NOT NULL,
    "damageDealt" BIGINT NOT NULL DEFAULT 0,
    "events" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "battle_rounds_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "battle_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "battleId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "battle_logs_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "battle_logs_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scout_reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attackerPlayerId" TEXT NOT NULL,
    "targetPlayerId" TEXT,
    "territoryId" TEXT,
    "data" JSONB NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scout_reports_attackerPlayerId_fkey" FOREIGN KEY ("attackerPlayerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scout_reports_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "scout_reports_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "territories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "quests" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_quests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "completedAt" DATETIME,
    "claimedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "player_quests_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_quests_questId_fkey" FOREIGN KEY ("questId") REFERENCES "quests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "target" INTEGER NOT NULL DEFAULT 1,
    "reward" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "player_achievements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "unlockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "player_achievements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "player_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievements" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clans" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clans_leaderPlayerId_fkey" FOREIGN KEY ("leaderPlayerId") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clan_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clanId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "contribution" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clan_members_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clan_members_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clan_invitations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clanId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "clan_invitations_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clan_invitations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clan_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clan_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clanId" TEXT NOT NULL,
    "senderPlayerId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "clan_messages_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clan_messages_senderPlayerId_fkey" FOREIGN KEY ("senderPlayerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clan_wars" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attackerClanId" TEXT NOT NULL,
    "defenderClanId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DECLARED',
    "declaredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "scoreAttacker" INTEGER NOT NULL DEFAULT 0,
    "scoreDefender" INTEGER NOT NULL DEFAULT 0,
    "winnerClanId" TEXT,
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clan_wars_attackerClanId_fkey" FOREIGN KEY ("attackerClanId") REFERENCES "clans" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clan_wars_defenderClanId_fkey" FOREIGN KEY ("defenderClanId") REFERENCES "clans" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clan_wars_winnerClanId_fkey" FOREIGN KEY ("winnerClanId") REFERENCES "clans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "clan_war_participations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "warId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "battles" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "clan_war_participations_warId_fkey" FOREIGN KEY ("warId") REFERENCES "clan_wars" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clan_war_participations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "market_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerPlayerId" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'SELL',
    "itemId" TEXT,
    "resource" TEXT,
    "unitPrice" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    CONSTRAINT "market_orders_sellerPlayerId_fkey" FOREIGN KEY ("sellerPlayerId") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "market_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "buyerPlayerId" TEXT NOT NULL,
    "sellerPlayerId" TEXT NOT NULL,
    "itemId" TEXT,
    "resource" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "market_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "market_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "market_transactions_buyerPlayerId_fkey" FOREIGN KEY ("buyerPlayerId") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "market_transactions_sellerPlayerId_fkey" FOREIGN KEY ("sellerPlayerId") REFERENCES "players" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPCOMING',
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "leaderboards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seasonId" TEXT,
    "category" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "rewards" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "leaderboards_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "leaderboards_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "world_bosses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "maxHp" BIGINT NOT NULL,
    "currentHp" BIGINT NOT NULL,
    "spawnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SPAWNED',
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "world_boss_damages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bossId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "damage" BIGINT NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "world_boss_damages_bossId_fkey" FOREIGN KEY ("bossId") REFERENCES "world_bosses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "world_boss_damages_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "targetPlayerId" TEXT,
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" DATETIME NOT NULL,
    "config" JSONB,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "events_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "deliveredVia" TEXT NOT NULL DEFAULT 'IN_APP',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "clanId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "announcements_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "clans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "permissions" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastActionAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "admin_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "diplomacy_relations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "since" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "spy_missions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "targetPlayerId" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "successChance" INTEGER NOT NULL,
    "success" BOOLEAN,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completesAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "result" JSONB,
    CONSTRAINT "spy_missions_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spy_missions_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "playerId" TEXT,
    "action" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "players_userId_key" ON "players"("userId");

-- CreateIndex
CREATE INDEX "players_power_idx" ON "players"("power");

-- CreateIndex
CREATE INDEX "players_honor_idx" ON "players"("honor");

-- CreateIndex
CREATE INDEX "players_clanId_idx" ON "players"("clanId");

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
