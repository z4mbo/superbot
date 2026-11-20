use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Error, SpaceFeatures, ThreadTarget};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InboxState {
    Unread,
    Read,
    Done,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InboxKind {
    Question,
    Active,
    Result,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConversationTarget {
    Bot { bot_id: String },
    Group { group_id: String },
    BotConversation { bot_id: String, thread_id: String },
}

impl ConversationTarget {
    pub fn as_target(&self) -> ThreadTarget<'_> {
        match self {
            Self::Bot { bot_id } => ThreadTarget::Bot(bot_id),
            Self::Group { group_id } => ThreadTarget::Group(group_id),
            Self::BotConversation { bot_id, thread_id } => {
                ThreadTarget::BotConversation { bot_id, thread_id }
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: InboxKind,
    pub state: InboxState,
    pub target: ConversationTarget,
    pub message_id: Option<String>,
    pub run_id: String,
    pub bot_id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LibraryKind {
    Artifact,
    Page,
    App,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub kind: LibraryKind,
    pub title: String,
    pub message_id: Option<String>,
    pub author_user_id: Option<String>,
    pub author_bot_id: Option<String>,
    pub mime_type: Option<String>,
    pub created_at: String,
}

impl SpaceFeatures<'_> {
    pub async fn inbox(&self, include_done: bool) -> Result<Vec<InboxItem>, Error> {
        self.call("inbox/list", json!({ "includeDone": include_done }))
            .await
    }

    pub async fn set_inbox_state(&self, id: &str, state: InboxState) -> Result<(), Error> {
        self.acknowledge("inbox/setState", json!({ "id": id, "state": state }))
            .await
    }

    pub async fn conversation_library(
        &self,
        target: ThreadTarget<'_>,
    ) -> Result<Vec<LibraryItem>, Error> {
        self.call("conversationLibrary/list", target).await
    }
}
