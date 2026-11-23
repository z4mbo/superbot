CREATE TYPE "RegistryPluginStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "registry_plugins" (
    "slug" TEXT PRIMARY KEY,
    "publisherId" TEXT REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "registry_plugins_publisherId_idx" ON "registry_plugins"("publisherId");

CREATE TABLE "registry_plugin_versions" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL REFERENCES "registry_plugins"("slug") ON DELETE RESTRICT ON UPDATE CASCADE,
    "version" INTEGER NOT NULL CHECK ("version" > 0),
    "manifest" JSONB NOT NULL,
    "status" "RegistryPluginStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewerId" TEXT REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    UNIQUE ("slug", "version"),
    UNIQUE ("id", "slug")
);
CREATE INDEX "registry_plugin_versions_status_id_idx" ON "registry_plugin_versions"("status", "id");
CREATE INDEX "registry_plugin_versions_reviewerId_idx" ON "registry_plugin_versions"("reviewerId");

CREATE TABLE "registry_plugin_installs" (
    "id" TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("spaceId", "userId", "slug"),
    FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("versionId", "slug") REFERENCES "registry_plugin_versions"("id", "slug") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "registry_plugin_installs_userId_idx" ON "registry_plugin_installs"("userId");
CREATE INDEX "registry_plugin_installs_versionId_slug_idx" ON "registry_plugin_installs"("versionId", "slug");

CREATE TABLE "registry_plugin_grants" (
    "id" TEXT PRIMARY KEY,
    "installationId" TEXT NOT NULL REFERENCES "registry_plugin_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "partId" TEXT NOT NULL,
    UNIQUE ("installationId", "botId", "partId")
);
CREATE INDEX "registry_plugin_grants_botId_idx" ON "registry_plugin_grants"("botId");

ALTER TABLE "registry_plugins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "registry_plugin_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "registry_plugin_installs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "registry_plugin_grants" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "registry_plugins_owner_read" ON "registry_plugins" FOR SELECT
    USING ("publisherId" = current_setting('app.user_id', true));
CREATE POLICY "registry_plugins_owner_insert" ON "registry_plugins" FOR INSERT
    WITH CHECK ("publisherId" = current_setting('app.user_id', true));
CREATE POLICY "registry_plugins_system" ON "registry_plugins" USING ((SELECT app_rls_bypass()));

CREATE POLICY "registry_plugin_versions_auth_read" ON "registry_plugin_versions" FOR SELECT
    USING (
        ("status" = 'approved' AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM "registry_plugins" AS p WHERE p."slug" = "registry_plugin_versions"."slug")
    );
CREATE POLICY "registry_plugin_versions_owner_insert" ON "registry_plugin_versions" FOR INSERT
    WITH CHECK (
        "status" = 'pending' AND "reviewedAt" IS NULL AND "reviewerId" IS NULL AND "reason" IS NULL
        AND EXISTS (SELECT 1 FROM "registry_plugins" AS p WHERE p."slug" = "registry_plugin_versions"."slug")
    );
CREATE POLICY "registry_plugin_versions_system" ON "registry_plugin_versions" USING ((SELECT app_rls_bypass()));

CREATE POLICY "registry_plugin_installs_tenant" ON "registry_plugin_installs"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true))
    WITH CHECK (
        "spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true)
        AND EXISTS (
            SELECT 1 FROM "registry_plugin_versions" AS v
            WHERE v."id" = "versionId" AND v."status" = 'approved'
        )
    );
CREATE POLICY "registry_plugin_installs_system" ON "registry_plugin_installs" USING ((SELECT app_rls_bypass()));

CREATE POLICY "registry_plugin_grants_tenant" ON "registry_plugin_grants"
    USING (EXISTS (SELECT 1 FROM "registry_plugin_installs" AS i WHERE i."id" = "installationId"))
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "registry_plugin_installs" AS i
            JOIN "bots" AS b ON b."id" = "botId" AND b."spaceId" = i."spaceId" AND b."userId" = i."userId"
            WHERE i."id" = "installationId" AND b."archivedAt" IS NULL
        )
    );
CREATE POLICY "registry_plugin_grants_system" ON "registry_plugin_grants" USING ((SELECT app_rls_bypass()));
