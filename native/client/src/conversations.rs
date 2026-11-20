use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Client, Error};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotConversation {
    pub thread_id: String,
    pub bot_id: String,
    pub created_at: String,
    pub title: Option<String>,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    pub preview: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotConversationPatch<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBotConversation<'a> {
    bot_id: &'a str,
    thread_id: &'a str,
    #[serde(flatten)]
    patch: BotConversationPatch<'a>,
}

impl Client {
    pub async fn update_bot_conversation(
        &self,
        space_id: &str,
        bot_id: &str,
        thread_id: &str,
        patch: BotConversationPatch<'_>,
    ) -> Result<BotConversation, Error> {
        self.rpc(
            "threads/updateBotConversation",
            Some(space_id),
            json!(UpdateBotConversation {
                bot_id,
                thread_id,
                patch
            }),
        )
        .await
    }

    pub async fn create_bot_conversation(
        &self,
        space_id: &str,
        bot_id: &str,
    ) -> Result<BotConversation, Error> {
        self.rpc(
            "threads/createBotConversation",
            Some(space_id),
            json!({ "botId": bot_id }),
        )
        .await
    }

    pub async fn bot_conversations(
        &self,
        space_id: &str,
        bot_id: &str,
    ) -> Result<Vec<BotConversation>, Error> {
        self.rpc(
            "threads/listBotConversations",
            Some(space_id),
            json!({ "botId": bot_id }),
        )
        .await
    }
}
