CREATE TABLE "registry_app_records" (
    "id" UUID PRIMARY KEY,
    "installationId" TEXT NOT NULL REFERENCES "registry_plugin_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "versionId" TEXT NOT NULL REFERENCES "registry_plugin_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "partId" TEXT NOT NULL,
    "operationId" UUID NOT NULL,
    "values" JSONB,
    "recordDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "registry_app_records_operation_key" UNIQUE ("installationId", "partId", "operationId"),
    CONSTRAINT "registry_app_records_live_values_check" CHECK (
        ("removedAt" IS NULL AND "values" IS NOT NULL AND jsonb_typeof("values") = 'object')
        OR ("removedAt" IS NOT NULL AND "values" IS NULL AND "recordDate" IS NULL)
    )
);

CREATE INDEX "registry_app_records_page_idx" ON "registry_app_records"
    ("installationId", "versionId", "partId", "removedAt", "createdAt", "id");
CREATE INDEX "registry_app_records_date_page_idx" ON "registry_app_records"
    ("installationId", "versionId", "partId", "recordDate", "removedAt", "createdAt", "id");
CREATE INDEX "registry_app_records_versionId_idx" ON "registry_app_records"("versionId");

ALTER TABLE "registry_app_records" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "registry_app_records_tenant" ON "registry_app_records"
    USING (EXISTS (
        SELECT 1 FROM "registry_plugin_installs" AS i
        JOIN "registry_plugin_versions" AS v ON v."id" = i."versionId"
        WHERE i."id" = "registry_app_records"."installationId"
          AND i."versionId" = "registry_app_records"."versionId"
          AND i."spaceId" = current_setting('app.space_id', true)
          AND i."userId" = current_setting('app.user_id', true)
          AND v."status" = 'approved'
    ));
CREATE POLICY "registry_app_records_system" ON "registry_app_records"
    USING ((SELECT app_rls_bypass()));
