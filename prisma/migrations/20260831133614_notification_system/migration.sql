-- CreateTable
CREATE TABLE "notification_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channels" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "claimedBy" TEXT,
    "lastError" TEXT,
    "notificationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "notification_queue_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "notification_queue_status_availableAt_idx" ON "notification_queue"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notification_queue_playerId_createdAt_idx" ON "notification_queue"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_queue_playerId_type_dedupeKey_key" ON "notification_queue"("playerId", "type", "dedupeKey");
