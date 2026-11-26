-- Additive: new tables only, which the previous release never reads. A person's sign-in source
-- connection (its tokens sit sealed in "secrets") and the sign-in requests their bots make.

-- CreateTable
CREATE TABLE "sign_in_sources" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "refreshAt" TIMESTAMP(3),
    "connectExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sign_in_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_in_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT,
    "messageId" TEXT,
    "provider" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "approvalLink" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT,
    "openedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "grantExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sign_in_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_sources_userId_key" ON "sign_in_sources"("userId");

-- CreateIndex
CREATE INDEX "sign_in_requests_userId_provider_site_status_idx" ON "sign_in_requests"("userId", "provider", "site", "status");

-- AddForeignKey
ALTER TABLE "sign_in_sources" ADD CONSTRAINT "sign_in_sources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sign_in_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sign_in_sources_tenant" ON "sign_in_sources"
    USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY "sign_in_sources_system" ON "sign_in_sources" USING ((SELECT app_rls_bypass()));

ALTER TABLE "sign_in_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sign_in_requests_tenant" ON "sign_in_requests"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY "sign_in_requests_system" ON "sign_in_requests" USING ((SELECT app_rls_bypass()));
