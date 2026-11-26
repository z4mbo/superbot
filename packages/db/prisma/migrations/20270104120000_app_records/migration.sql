-- First-party apps ship with the deployment and have no author; server functions are stored
-- with their release. Both are additive: the previous release never writes these columns, and
-- only the new release lists or reads a release without an author.
ALTER TABLE "app_releases" ALTER COLUMN "authorUserId" DROP NOT NULL;
ALTER TABLE "app_releases" ADD COLUMN "firstParty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_releases" ADD COLUMN "server" TEXT;

-- CreateTable
CREATE TABLE "app_records" (
    "installId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "bytes" INTEGER NOT NULL,
    "s0" TEXT,
    "s1" TEXT,
    "s2" TEXT,
    "n0" DOUBLE PRECISION,
    "n1" DOUBLE PRECISION,
    "n2" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_records_pkey" PRIMARY KEY ("installId","spaceId","collection","id")
);

-- CreateIndex
CREATE INDEX "app_records_spaceId_idx" ON "app_records"("spaceId");
CREATE INDEX "app_records_installId_spaceId_collection_createdAt_idx" ON "app_records"("installId", "spaceId", "collection", "createdAt");
CREATE INDEX "app_records_installId_spaceId_collection_s0_idx" ON "app_records"("installId", "spaceId", "collection", "s0");
CREATE INDEX "app_records_installId_spaceId_collection_s1_idx" ON "app_records"("installId", "spaceId", "collection", "s1");
CREATE INDEX "app_records_installId_spaceId_collection_s2_idx" ON "app_records"("installId", "spaceId", "collection", "s2");
CREATE INDEX "app_records_installId_spaceId_collection_n0_idx" ON "app_records"("installId", "spaceId", "collection", "n0");
CREATE INDEX "app_records_installId_spaceId_collection_n1_idx" ON "app_records"("installId", "spaceId", "collection", "n1");
CREATE INDEX "app_records_installId_spaceId_collection_n2_idx" ON "app_records"("installId", "spaceId", "collection", "n2");

-- AddForeignKey
ALTER TABLE "app_records" ADD CONSTRAINT "app_records_installId_fkey" FOREIGN KEY ("installId") REFERENCES "capability_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_records" ADD CONSTRAINT "app_records_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A record belongs to its install's person, in the Space it was written in, and to nobody else.
ALTER TABLE "app_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app_records_tenant" ON "app_records"
    USING (
        "spaceId" = NULLIF(current_setting('app.space_id', true), '')
        AND EXISTS (
            SELECT 1 FROM "capability_installs" AS i
            WHERE i."id" = "app_records"."installId"
              AND i."userId" = NULLIF(current_setting('app.user_id', true), '')
        )
    );
CREATE POLICY "app_records_system" ON "app_records" USING ((SELECT app_rls_bypass()));
