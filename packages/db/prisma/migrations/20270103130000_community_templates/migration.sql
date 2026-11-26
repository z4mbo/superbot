-- Additive: new tables only, which the previous release never reads. They hold the templates
-- people share from their bots and the admin review of each version.

-- CreateTable
CREATE TABLE "community_templates" (
    "slug" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_templates_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "community_template_versions" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "recipe" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_templates_authorId_idx" ON "community_templates"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "community_template_versions_slug_version_key" ON "community_template_versions"("slug", "version");

-- CreateIndex
CREATE INDEX "community_template_versions_status_createdAt_idx" ON "community_template_versions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "community_template_versions_reviewerId_idx" ON "community_template_versions"("reviewerId");

-- At most one listed version per template; approving a new one replaces it in the same transaction.
CREATE UNIQUE INDEX "community_template_versions_one_approved" ON "community_template_versions"("slug") WHERE "status" = 'approved';

-- AddForeignKey
ALTER TABLE "community_templates" ADD CONSTRAINT "community_templates_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_template_versions" ADD CONSTRAINT "community_template_versions_slug_fkey" FOREIGN KEY ("slug") REFERENCES "community_templates"("slug") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_template_versions" ADD CONSTRAINT "community_template_versions_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
