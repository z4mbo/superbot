CREATE TABLE "inbox_receipts" (
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    CONSTRAINT "inbox_receipts_pkey" PRIMARY KEY ("spaceId", "userId", "runId", "kind", "sourceKey"),
    CONSTRAINT "inbox_receipts_kind_check" CHECK ("kind" IN ('active', 'question', 'result')),
    CONSTRAINT "inbox_receipts_state_check" CHECK ("state" IN ('read', 'done')),
    CONSTRAINT "inbox_receipts_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inbox_receipts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "inbox_receipts_runId_idx" ON "inbox_receipts"("runId");

ALTER TABLE "inbox_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbox_receipts_tenant ON "inbox_receipts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
