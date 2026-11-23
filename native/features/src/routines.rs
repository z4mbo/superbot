use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{Error, ModelSelection, Patch, SpaceFeatures, ThinkingLevel};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineEmailSenders {
    Owner,
    Domain,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub prompt: String,
    pub crons: Vec<String>,
    pub timezone: String,
    pub active: bool,
    pub notify: bool,
    #[serde(default)]
    pub in_chat: bool,
    pub webhook_enabled: bool,
    pub github_enabled: bool,
    pub message_provider: Option<String>,
    pub email_senders: Option<RoutineEmailSenders>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub thinking_level: Option<ThinkingLevel>,
    pub watch: Option<Value>,
    pub watch_state: Option<Value>,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub schedule_delayed: Option<bool>,
    pub created_at: String,
    pub editable: Option<bool>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoutine<'a> {
    pub bot_id: &'a str,
    pub name: &'a str,
    pub prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crons: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_chat: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_provider: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_senders: Option<RoutineEmailSenders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSelection<'a>>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineUpdate<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crons: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_chat: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_at: Option<&'a str>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub message_provider: Patch<&'a str>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub email_senders: Patch<RoutineEmailSenders>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub thinking_level: Patch<ThinkingLevel>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSelection<'a>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCursor {
    pub id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: String,
    pub bot_id: String,
    pub group_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub late_since: Option<String>,
    pub completed_at: Option<String>,
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHistory {
    pub runs: Vec<RoutineRun>,
    pub next_cursor: Option<RoutineCursor>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunFilter {
    Active,
    Recent,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunActivity {
    pub run_id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub thread_id: String,
    pub status: String,
    pub trigger: String,
    pub notifications_enabled: bool,
    pub prompt_snippet: String,
    pub updated_at: String,
}

impl SpaceFeatures<'_> {
    pub async fn list_routines(&self, bot_id: &str) -> Result<Vec<Routine>, Error> {
        self.call("routines/list", json!({ "botId": bot_id })).await
    }

    pub async fn create_routine(&self, input: &CreateRoutine<'_>) -> Result<Routine, Error> {
        self.call("routines/create", input).await
    }

    pub async fn update_routine(
        &self,
        routine_id: &str,
        update: &RoutineUpdate<'_>,
    ) -> Result<Routine, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            routine_id: &'a str,
            #[serde(flatten)]
            update: &'a RoutineUpdate<'a>,
        }
        self.call("routines/update", Input { routine_id, update })
            .await
    }

    pub async fn routine_history(
        &self,
        routine_id: &str,
        before: Option<&RoutineCursor>,
        limit: Option<u32>,
    ) -> Result<RoutineHistory, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            routine_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            before: Option<&'a RoutineCursor>,
            #[serde(skip_serializing_if = "Option::is_none")]
            limit: Option<u32>,
        }
        self.call(
            "routines/history",
            Input {
                routine_id,
                before,
                limit,
            },
        )
        .await
    }

    pub async fn test_routine(
        &self,
        routine_id: &str,
        client_nonce: Option<&str>,
    ) -> Result<String, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            routine_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            client_nonce: Option<&'a str>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Receipt {
            run_id: String,
        }
        let receipt: Receipt = self
            .call(
                "routines/testRun",
                Input {
                    routine_id,
                    client_nonce,
                },
            )
            .await?;
        Ok(receipt.run_id)
    }

    pub async fn remove_routine(&self, routine_id: &str) -> Result<(), Error> {
        self.acknowledge("routines/remove", json!({ "routineId": routine_id }))
            .await
    }

    pub async fn list_runs(&self, filter: RunFilter) -> Result<Vec<RunActivity>, Error> {
        #[derive(Deserialize)]
        struct Output {
            runs: Vec<RunActivity>,
        }
        let output: Output = self.call("runs/list", json!({ "filter": filter })).await?;
        Ok(output.runs)
    }
}
