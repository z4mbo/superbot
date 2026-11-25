-- Additive: older releases never read or write this table.
CREATE TABLE "routine_app_events" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "handle" TEXT,
    "renewAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routine_app_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "routine_app_events_connectorId_handle_key"
    ON "routine_app_events"("connectorId", "handle");
CREATE INDEX "routine_app_events_routineId_idx" ON "routine_app_events"("routineId");
CREATE INDEX "routine_app_events_connectionId_idx" ON "routine_app_events"("connectionId");

ALTER TABLE "routine_app_events" ADD CONSTRAINT "routine_app_events_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routine_app_events" ADD CONSTRAINT "routine_app_events_routineId_fkey"
    FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deliveries find their routine across Spaces as system; members read their Space's rows.
ALTER TABLE "routine_app_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_app_events_tenant ON "routine_app_events"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY routine_app_events_system ON "routine_app_events"
  USING ((SELECT app_rls_bypass()));
