-- AlterTable
ALTER TABLE "plugin_submissions" ADD COLUMN     "appReleaseId" TEXT;

-- CreateTable
CREATE TABLE "app_releases" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "icon" TEXT,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_releases_authorUserId_idx" ON "app_releases"("authorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "app_releases_appId_version_key" ON "app_releases"("appId", "version");

-- CreateIndex
CREATE INDEX "plugin_submissions_appReleaseId_idx" ON "plugin_submissions"("appReleaseId");

-- AddForeignKey
ALTER TABLE "plugin_submissions" ADD CONSTRAINT "plugin_submissions_appReleaseId_fkey" FOREIGN KEY ("appReleaseId") REFERENCES "app_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

