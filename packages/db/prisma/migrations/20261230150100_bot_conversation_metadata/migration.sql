ALTER TABLE "threads"
  ADD COLUMN "conversationTitle" TEXT,
  ADD COLUMN "conversationPinnedAt" TIMESTAMP(3),
  ADD COLUMN "conversationArchivedAt" TIMESTAMP(3);
