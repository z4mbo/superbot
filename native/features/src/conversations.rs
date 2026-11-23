use crate::{BotConversation, BotConversationPatch, Error, SpaceFeatures};

impl SpaceFeatures<'_> {
    pub async fn update_bot_conversation(
        &self,
        bot_id: &str,
        thread_id: &str,
        patch: BotConversationPatch<'_>,
    ) -> Result<BotConversation, Error> {
        self.features
            .client
            .update_bot_conversation(&self.id, bot_id, thread_id, patch)
            .await
    }

    pub async fn create_bot_conversation(&self, bot_id: &str) -> Result<BotConversation, Error> {
        self.features
            .client
            .create_bot_conversation(&self.id, bot_id)
            .await
    }

    pub async fn bot_conversations(&self, bot_id: &str) -> Result<Vec<BotConversation>, Error> {
        self.features
            .client
            .bot_conversations(&self.id, bot_id)
            .await
    }
}
