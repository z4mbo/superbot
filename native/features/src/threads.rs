use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub use superbot_client::ThreadTarget;
use superbot_client::{EventStream, MessageAuthor, SendReceipt};

use crate::{Error, SpaceFeatures};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHead {
    pub thread_id: String,
    pub cursor: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: String,
    pub thread_id: String,
    pub seq: i64,
    pub role: String,
    pub blocks: Vec<Value>,
    pub bot_id: Option<String>,
    pub author: Option<MessageAuthor>,
    pub run_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub reply_quote: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    pub thread_id: String,
    pub messages: Vec<ThreadMessage>,
    pub older_cursor: Option<u64>,
    pub covered_through_seq: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread_id: String,
    pub cursor: i64,
    pub messages: Vec<ThreadMessage>,
    pub older_cursor: Option<u64>,
    pub bot_id: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub run: Option<Value>,
    pub active_runs: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePageOptions<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_peer_runs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_peer_receipts: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub around: Option<MessageAnchor<'a>>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub enum MessageAnchor<'a> {
    #[serde(rename = "messageId")]
    Message(&'a str),
    #[serde(rename = "seq")]
    Sequence(u64),
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'a str>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub artifact_ids: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_quote: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_nonce: Option<&'a str>,
}

#[derive(Serialize)]
pub(crate) struct TargetInput<'a, T> {
    #[serde(flatten)]
    pub target: ThreadTarget<'a>,
    #[serde(flatten)]
    pub fields: T,
}

impl SpaceFeatures<'_> {
    pub async fn subscribe_thread(
        &self,
        target: ThreadTarget<'_>,
        cursor: i64,
    ) -> Result<EventStream, Error> {
        self.features
            .client
            .subscribe_thread(&self.id, target, cursor)
            .await
    }

    pub async fn thread_head(&self, target: ThreadTarget<'_>) -> Result<ThreadHead, Error> {
        self.call("threads/head", target).await
    }

    pub async fn thread(&self, target: ThreadTarget<'_>) -> Result<ThreadSnapshot, Error> {
        self.call("threads/get", target).await
    }

    pub async fn thread_messages(
        &self,
        target: ThreadTarget<'_>,
        fields: &MessagePageOptions<'_>,
    ) -> Result<ThreadPage, Error> {
        self.call("threads/messages", TargetInput { target, fields })
            .await
    }

    pub async fn send(
        &self,
        target: ThreadTarget<'_>,
        fields: &SendMessage<'_>,
    ) -> Result<SendReceipt, Error> {
        self.call("threads/send", TargetInput { target, fields })
            .await
    }

    pub async fn stop_thread(&self, target: ThreadTarget<'_>) -> Result<(), Error> {
        self.acknowledge("threads/stop", target).await
    }

    pub async fn clear_thread(&self, target: ThreadTarget<'_>) -> Result<(), Error> {
        self.acknowledge("threads/clear", target).await
    }

    pub async fn mark_read(&self, target: ThreadTarget<'_>) -> Result<Option<i64>, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ReadReceipt {
            #[serde(flatten)]
            acknowledgement: crate::Acknowledgement,
            unread_after_seq: Option<i64>,
        }
        let receipt: ReadReceipt = self.call("threads/markRead", target).await?;
        receipt.acknowledgement.validate()?;
        Ok(receipt.unread_after_seq)
    }

    pub async fn mark_unread(
        &self,
        target: ThreadTarget<'_>,
        message_id: Option<&str>,
    ) -> Result<(), Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            message_id: Option<&'a str>,
        }
        let fields = Fields { message_id };
        self.acknowledge("threads/markUnread", TargetInput { target, fields })
            .await
    }

    pub async fn snooze_thread(
        &self,
        target: ThreadTarget<'_>,
        until: Option<&str>,
    ) -> Result<(), Error> {
        let fields = json!({ "until": until });
        self.acknowledge("threads/snooze", TargetInput { target, fields })
            .await
    }
}
