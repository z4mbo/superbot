ALTER TABLE "messages" ADD COLUMN "localOperationId" UUID;

CREATE UNIQUE INDEX "messages_local_operation_key"
ON "messages" ("threadId", "authorUserId", "localOperationId", "role");
