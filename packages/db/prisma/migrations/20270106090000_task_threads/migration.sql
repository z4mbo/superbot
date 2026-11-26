-- Additive: a nullable column the previous release never reads. It links a task thread to the
-- conversation that started it with the `delegate` tool.

-- AlterTable
ALTER TABLE "threads" ADD COLUMN "parentThreadId" TEXT;

-- CreateIndex
CREATE INDEX "threads_parentThreadId_createdAt_idx" ON "threads"("parentThreadId", "createdAt");

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
