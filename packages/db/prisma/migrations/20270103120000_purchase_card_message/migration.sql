-- Additive: a nullable column the previous release never reads. It links a wallet purchase to the
-- chat message that shows its card, so the card can follow the purchase's status.
ALTER TABLE "purchases" ADD COLUMN "messageId" TEXT;
