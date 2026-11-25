-- Media provider keys a user connects for image and video generation, and which provider and
-- model each kind uses first. Both tables are new, so the previous release never reads them.
CREATE TABLE "user_media_credentials" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "hints" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_media_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_media_credentials_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_media_credentials_userId_provider_key"
  ON "user_media_credentials"("userId", "provider");

CREATE TABLE "user_media_preferences" (
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_media_preferences_pkey" PRIMARY KEY ("userId", "kind"),
  CONSTRAINT "user_media_preferences_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "user_media_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_media_credentials_tenant ON "user_media_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_media_credentials_system ON "user_media_credentials"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "user_media_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_media_preferences_tenant ON "user_media_preferences"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_media_preferences_system ON "user_media_preferences"
  USING (current_setting('app.rls_bypass', true) = 'on');
