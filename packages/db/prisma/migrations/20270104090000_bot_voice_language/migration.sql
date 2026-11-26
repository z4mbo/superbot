-- A bot's voice language; null detects it. Additive: the previous release never reads it.
ALTER TABLE "bots" ADD COLUMN "voiceLanguage" TEXT;
