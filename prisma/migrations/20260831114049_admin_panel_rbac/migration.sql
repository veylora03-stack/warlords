-- AlterTable
ALTER TABLE "events" ADD COLUMN "body" TEXT;
ALTER TABLE "events" ADD COLUMN "createdById" TEXT;
ALTER TABLE "events" ADD COLUMN "title" TEXT;

-- CreateIndex
CREATE INDEX "players_name_idx" ON "players"("name");
