-- Additive: new tables only, which the previous release never reads. They hold a durable agent
-- harness's records (`PostgresDurableStorage` in packages/adapters), and nothing writes them until
-- a durable runtime is configured.

-- CreateTable
CREATE TABLE "durable_stores" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "nextId" BIGINT NOT NULL DEFAULT 2,
    "nextSeq" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "durable_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "durable_record_ids" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "recordType" TEXT NOT NULL,

    CONSTRAINT "durable_record_ids_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_conversations" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "ownerConversationId" BIGINT,
    "ownerTaskId" BIGINT,
    "record" TEXT NOT NULL,

    CONSTRAINT "durable_conversations_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_entries" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "conversationId" BIGINT NOT NULL,
    "head" BIGINT,
    "commitSeq" BIGINT NOT NULL,
    "record" TEXT NOT NULL,

    CONSTRAINT "durable_entries_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_tasks" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "conversationId" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "abortRequested" BOOLEAN NOT NULL,
    "background" BOOLEAN NOT NULL,
    "record" TEXT NOT NULL,

    CONSTRAINT "durable_tasks_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_submissions" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "conversationId" BIGINT NOT NULL,
    "requestId" TEXT,
    "status" TEXT NOT NULL,
    "record" TEXT NOT NULL,

    CONSTRAINT "durable_submissions_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_documents" (
    "storeId" TEXT NOT NULL,
    "id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "family" BOOLEAN NOT NULL,
    "keyValue" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "ownerId" BIGINT NOT NULL,
    "createdSeq" BIGINT NOT NULL,
    "retiredSeq" BIGINT,
    "record" TEXT NOT NULL,

    CONSTRAINT "durable_documents_pkey" PRIMARY KEY ("storeId","id")
);

-- CreateTable
CREATE TABLE "durable_document_revisions" (
    "storeId" TEXT NOT NULL,
    "documentId" BIGINT NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "durable_document_revisions_pkey" PRIMARY KEY ("storeId","documentId","seq")
);

-- CreateIndex
CREATE INDEX "durable_stores_spaceId_idx" ON "durable_stores"("spaceId");

-- CreateIndex
CREATE INDEX "durable_conversations_storeId_ownerConversationId_id_idx" ON "durable_conversations"("storeId", "ownerConversationId", "id");

-- CreateIndex
CREATE INDEX "durable_conversations_storeId_ownerTaskId_id_idx" ON "durable_conversations"("storeId", "ownerTaskId", "id");

-- CreateIndex
CREATE INDEX "durable_entries_storeId_conversationId_id_idx" ON "durable_entries"("storeId", "conversationId", "id");

-- CreateIndex
CREATE INDEX "durable_tasks_storeId_status_id_idx" ON "durable_tasks"("storeId", "status", "id");

-- CreateIndex
CREATE INDEX "durable_tasks_storeId_conversationId_id_idx" ON "durable_tasks"("storeId", "conversationId", "id");

-- CreateIndex
CREATE INDEX "durable_tasks_storeId_kind_id_idx" ON "durable_tasks"("storeId", "kind", "id");

-- CreateIndex
CREATE INDEX "durable_submissions_storeId_conversationId_requestId_idx" ON "durable_submissions"("storeId", "conversationId", "requestId");

-- CreateIndex
CREATE INDEX "durable_submissions_storeId_conversationId_id_idx" ON "durable_submissions"("storeId", "conversationId", "id");

-- CreateIndex
CREATE INDEX "durable_submissions_storeId_status_id_idx" ON "durable_submissions"("storeId", "status", "id");

-- CreateIndex
CREATE INDEX "durable_documents_storeId_kind_scopeKind_ownerId_family_key_idx" ON "durable_documents"("storeId", "kind", "scopeKind", "ownerId", "family", "keyValue", "createdSeq");

-- CreateIndex
CREATE INDEX "durable_documents_storeId_scopeKind_ownerId_id_idx" ON "durable_documents"("storeId", "scopeKind", "ownerId", "id");

-- AddForeignKey
ALTER TABLE "durable_stores" ADD CONSTRAINT "durable_stores_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_record_ids" ADD CONSTRAINT "durable_record_ids_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_conversations" ADD CONSTRAINT "durable_conversations_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_entries" ADD CONSTRAINT "durable_entries_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_tasks" ADD CONSTRAINT "durable_tasks_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_submissions" ADD CONSTRAINT "durable_submissions_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_documents" ADD CONSTRAINT "durable_documents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_document_revisions" ADD CONSTRAINT "durable_document_revisions_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "durable_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The entries that carry a `head`, newest first per conversation: the lookup for the latest one.
CREATE INDEX "durable_entries_heads_idx" ON "durable_entries"("storeId", "conversationId", "id") WHERE "head" IS NOT NULL;

-- Transcripts are Space content: a tenant sees only its own Space's stores and their rows.
ALTER TABLE "durable_stores" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_stores_tenant" ON "durable_stores"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY "durable_stores_system" ON "durable_stores" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_record_ids" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_record_ids_tenant" ON "durable_record_ids"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_record_ids"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_record_ids_system" ON "durable_record_ids" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_conversations_tenant" ON "durable_conversations"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_conversations"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_conversations_system" ON "durable_conversations" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_entries_tenant" ON "durable_entries"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_entries"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_entries_system" ON "durable_entries" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_tasks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_tasks_tenant" ON "durable_tasks"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_tasks"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_tasks_system" ON "durable_tasks" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_submissions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_submissions_tenant" ON "durable_submissions"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_submissions"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_submissions_system" ON "durable_submissions" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_documents_tenant" ON "durable_documents"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_documents"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_documents_system" ON "durable_documents" USING ((SELECT app_rls_bypass()));

ALTER TABLE "durable_document_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "durable_document_revisions_tenant" ON "durable_document_revisions"
    USING (EXISTS (
        SELECT 1 FROM "durable_stores" s
        WHERE s."id" = "durable_document_revisions"."storeId"
            AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
CREATE POLICY "durable_document_revisions_system" ON "durable_document_revisions" USING ((SELECT app_rls_bypass()));
