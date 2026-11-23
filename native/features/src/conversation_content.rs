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
pub enum SearchHitKind {
    Conversation,
    Message,
    File,
    Link,
    Routine,
    #[serde(other)]
    Other,
}

/// One thing `search/query` found in the Space. Exactly one of `bot_id` and `group_id` is set;
/// `thread_id` names one of the bot's additional conversations.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: SearchHitKind,
    pub bot_id: Option<String>,
    pub bot_name: Option<String>,
    pub thread_id: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub title: String,
    pub snippet: String,
    pub message_id: Option<String>,
}

impl SearchHit {
    /// The conversation the hit is in.
    pub fn target(&self) -> Option<ConversationTarget> {
        match (&self.group_id, &self.bot_id, &self.thread_id) {
            (Some(group_id), None, None) => Some(ConversationTarget::Group {
                group_id: group_id.clone(),
            }),
            (None, Some(bot_id), Some(thread_id)) => Some(ConversationTarget::BotConversation {
                bot_id: bot_id.clone(),
                thread_id: thread_id.clone(),
            }),
            (None, Some(bot_id), None) => Some(ConversationTarget::Bot {
                bot_id: bot_id.clone(),
            }),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct SearchHits {
    hits: Vec<SearchHit>,
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

    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>, Error> {
        let found: SearchHits = self.call("search/query", json!({ "q": query })).await?;
        Ok(found.hits)
    }

    pub async fn conversation_library(
        &self,
        target: ThreadTarget<'_>,
    ) -> Result<Vec<LibraryItem>, Error> {
        self.call("conversationLibrary/list", target).await
    }
}
