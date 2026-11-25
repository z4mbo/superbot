-- A bot links one account on each chat app instead of one chat app in all. Every existing row
-- already satisfies the new key, since botId alone was unique, and the previous release's
-- lookups by botId use the new index.
CREATE UNIQUE INDEX "messaging_identities_botId_provider_key" ON "messaging_identities"("botId", "provider");

DROP INDEX "messaging_identities_botId_key";
