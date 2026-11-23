use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Client, Error, ThreadTarget};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistoryReceipt {
    pub message_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHistory<'a> {
    #[serde(flatten)]
    target: ThreadTarget<'a>,
    operation_id: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<&'a str>,
}

impl Client {
    /// Records a note without starting a run. Reuse the operation ID and payload on retries.
    pub async fn append_local_note(
        &self,
        space_id: &str,
        target: ThreadTarget<'_>,
        operation_id: &str,
        text: &str,
    ) -> Result<LocalHistoryReceipt, Error> {
        self.append_local_history(space_id, target, operation_id, text, None)
            .await
    }

    /// Records a completed local CLI exchange atomically. Reuse the operation ID and payload on retries.
    pub async fn append_local_turn(
        &self,
        space_id: &str,
        target: ThreadTarget<'_>,
        operation_id: &str,
        text: &str,
        reply: &str,
    ) -> Result<LocalHistoryReceipt, Error> {
        self.append_local_history(space_id, target, operation_id, text, Some(reply))
            .await
    }

    async fn append_local_history(
        &self,
        space_id: &str,
        target: ThreadTarget<'_>,
        operation_id: &str,
        text: &str,
        reply: Option<&str>,
    ) -> Result<LocalHistoryReceipt, Error> {
        self.rpc(
            "threads/appendLocalHistory",
            Some(space_id),
            json!(LocalHistory {
                target,
                operation_id,
                text,
                reply,
            }),
        )
        .await
    }
}
