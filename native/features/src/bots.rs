use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{empty, Error, Patch, SpaceFeatures};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub space_id: String,
    pub thread_id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub instructions: String,
    pub instruction_history: Option<Vec<InstructionVersion>>,
    pub color: String,
    pub unread: bool,
    pub snoozed_until: Option<String>,
    pub preview: String,
    pub status: String,
    pub thread_status: Option<String>,
    pub updated_at: String,
    pub created_at: String,
    pub notify_on_finish: bool,
    pub pinned: bool,
    pub section_id: Option<String>,
    pub archived_at: Option<String>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub thinking_level: Option<ThinkingLevel>,
    pub computer_mode: ComputerMode,
    pub auto_speak: bool,
    pub voice_id: Option<String>,
    pub reply_mode: Option<ReplyMode>,
    pub memory_scope: Option<MemoryScope>,
    pub team_chat_ambient_enabled: bool,
    pub team_chat_rules: String,
    pub cross_space_communication: Option<bool>,
    pub daily_check_ins: Option<bool>,
    pub fleet_management: Option<bool>,
    #[serde(default)]
    pub disabled_builtin_tools: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionVersion {
    pub id: String,
    pub instructions: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerMode {
    Team,
    Dedicated,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyMode {
    Chat,
    Messages,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Isolated,
    Shared,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBot<'a> {
    pub name: &'a str,
    /// Repeated creation with this key resolves to the same bot in the Space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_on_finish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer_mode: Option<ComputerMode>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection<'a> {
    model_provider: Option<&'a str>,
    model_id: Option<&'a str>,
}

impl<'a> ModelSelection<'a> {
    pub fn set(provider: &'a str, id: &'a str) -> Self {
        Self {
            model_provider: Some(provider),
            model_id: Some(id),
        }
    }

    pub fn clear() -> Self {
        Self {
            model_provider: None,
            model_id: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSettings<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_instructions: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_on_finish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_speak: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_mode: Option<ReplyMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_chat_ambient_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_chat_rules: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_space_communication: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_check_ins: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fleet_management: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_builtin_tools: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub section_id: Patch<&'a str>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub voice_id: Patch<&'a str>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub memory_scope: Patch<MemoryScope>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub thinking_level: Patch<ThinkingLevel>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSelection<'a>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub bot_id: String,
    pub name: String,
    pub color: String,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub space_id: String,
    pub thread_id: String,
    pub name: String,
    pub members: Vec<GroupMember>,
    pub pinned: bool,
    pub section_id: Option<String>,
    pub archived_at: Option<String>,
    pub unread: bool,
    pub preview: String,
    pub snoozed_until: Option<String>,
    pub updated_at: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSettings<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_ids: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_bot_ids: Option<&'a [&'a str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub section_id: Patch<&'a str>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GroupDetail {
    #[serde(flatten)]
    pub group: Group,
    pub messages: Option<Vec<crate::ThreadMessage>>,
}

impl SpaceFeatures<'_> {
    pub async fn list_bots(&self) -> Result<Vec<Bot>, Error> {
        self.call("bots/list", empty()).await
    }

    pub async fn list_archived_bots(&self) -> Result<Vec<Bot>, Error> {
        self.call("bots/listArchived", empty()).await
    }

    pub async fn bot(&self, bot_id: &str) -> Result<Bot, Error> {
        self.call("bots/get", json!({ "botId": bot_id })).await
    }

    pub async fn duplicate_bot(&self, bot_id: &str) -> Result<Bot, Error> {
        self.call("bots/duplicate", json!({ "botId": bot_id }))
            .await
    }

    pub async fn archive_bot(&self, bot_id: &str) -> Result<(), Error> {
        self.acknowledge("bots/archive", json!({ "botId": bot_id }))
            .await
    }

    pub async fn restore_bot(&self, bot_id: &str) -> Result<(), Error> {
        self.acknowledge("bots/restore", json!({ "botId": bot_id }))
            .await
    }

    pub async fn list_groups(&self) -> Result<Vec<Group>, Error> {
        self.call("groups/list", empty()).await
    }

    pub async fn list_archived_groups(&self) -> Result<Vec<Group>, Error> {
        self.call("groups/listArchived", empty()).await
    }

    pub async fn group(&self, group_id: &str) -> Result<GroupDetail, Error> {
        self.call("groups/get", json!({ "groupId": group_id }))
            .await
    }

    pub async fn duplicate_group(&self, group_id: &str) -> Result<Group, Error> {
        self.call("groups/duplicate", json!({ "groupId": group_id }))
            .await
    }

    pub async fn archive_group(&self, group_id: &str) -> Result<(), Error> {
        self.acknowledge("groups/archive", json!({ "groupId": group_id }))
            .await
    }

    pub async fn restore_group(&self, group_id: &str) -> Result<(), Error> {
        self.acknowledge("groups/restore", json!({ "groupId": group_id }))
            .await
    }

    pub async fn remove_group(&self, group_id: &str) -> Result<(), Error> {
        self.acknowledge("groups/remove", json!({ "groupId": group_id }))
            .await
    }

    pub async fn create_bot(&self, input: &CreateBot<'_>) -> Result<Bot, Error> {
        self.call("bots/create", input).await
    }

    pub async fn update_bot(&self, bot_id: &str, settings: &BotSettings<'_>) -> Result<Bot, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            bot_id: &'a str,
            #[serde(flatten)]
            settings: &'a BotSettings<'a>,
        }
        self.call("bots/update", Input { bot_id, settings }).await
    }

    pub async fn set_bot_computer(&self, bot_id: &str, mode: ComputerMode) -> Result<Bot, Error> {
        self.call("bots/setComputer", json!({ "botId": bot_id, "mode": mode }))
            .await
    }

    pub async fn create_group(&self, name: &str, bot_ids: &[&str]) -> Result<Group, Error> {
        self.call("groups/create", json!({ "name": name, "botIds": bot_ids }))
            .await
    }

    pub async fn update_group(
        &self,
        group_id: &str,
        settings: &GroupSettings<'_>,
    ) -> Result<Group, Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            group_id: &'a str,
            #[serde(flatten)]
            settings: &'a GroupSettings<'a>,
        }
        self.call("groups/update", Input { group_id, settings })
            .await
    }
}
