-- AlterTable
ALTER TABLE "pages" ADD COLUMN "appInstallId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "pages_appInstallId_spaceId_key" ON "pages"("appInstallId", "spaceId");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_appInstallId_fkey" FOREIGN KEY ("appInstallId") REFERENCES "capability_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
