ALTER TABLE "threads" ADD COLUMN "conversationBotId" TEXT;
ALTER TABLE "threads" ADD CONSTRAINT "threads_conversationBotId_fkey" FOREIGN KEY ("conversationBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "helperBotId", "conversationBotId") = 1
) NOT VALID;
