use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{empty, threads::TargetInput, Error, SpaceFeatures, ThreadTarget};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsScope {
    Account,
    Space,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalEffect {
    AlwaysAllow,
    RequireApproval,
    Deny,
}

#[derive(Clone, Copy, Debug)]
pub enum ApprovalMatch<'a> {
    Tool(&'a str),
    Connector(&'a str),
    Site(&'a str),
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMatchKind {
    Tool,
    Connector,
    Category,
    Site,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRule {
    pub id: String,
    pub effect: ApprovalEffect,
    pub match_kind: ApprovalMatchKind,
    pub match_value: String,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Never,
    Auto,
    Ask,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoReview {
    pub mode: ApprovalMode,
    pub enabled: bool,
    pub checker_available: bool,
    pub skip_approvals: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceSetting {
    Models,
    Voice,
    Confirmations,
    Credentials,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct Scope {
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<SettingsScope>,
}

impl SpaceFeatures<'_> {
    /// Submit an answer ID offered by a pending card. The server interprets the ID in that card's context.
    pub async fn answer_thread_card(
        &self,
        target: ThreadTarget<'_>,
        run_id: &str,
        message_id: &str,
        answer: &str,
    ) -> Result<(), Error> {
        let fields = json!({ "runId": run_id, "messageId": message_id, "answer": answer });
        self.acknowledge("threads/answer", TargetInput { target, fields })
            .await
    }

    pub async fn approval_rules(
        &self,
        scope: Option<SettingsScope>,
    ) -> Result<Vec<ApprovalRule>, Error> {
        self.call("approvalRules/list", Scope { scope }).await
    }

    pub async fn set_approval_rule(
        &self,
        scope: Option<SettingsScope>,
        effect: ApprovalEffect,
        matcher: ApprovalMatch<'_>,
    ) -> Result<ApprovalRule, Error> {
        let (match_kind, match_value) = match matcher {
            ApprovalMatch::Tool(value) => (ApprovalMatchKind::Tool, value),
            ApprovalMatch::Connector(value) => (ApprovalMatchKind::Connector, value),
            ApprovalMatch::Site(value) => (ApprovalMatchKind::Site, value),
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input<'a> {
            #[serde(flatten)]
            scope: Scope,
            effect: ApprovalEffect,
            match_kind: ApprovalMatchKind,
            match_value: &'a str,
        }
        self.call(
            "approvalRules/set",
            Input {
                scope: Scope { scope },
                effect,
                match_kind,
                match_value,
            },
        )
        .await
    }

    pub async fn remove_approval_rule(
        &self,
        scope: Option<SettingsScope>,
        id: &str,
    ) -> Result<(), Error> {
        #[derive(Serialize)]
        struct Input<'a> {
            #[serde(flatten)]
            scope: Scope,
            id: &'a str,
        }
        self.acknowledge(
            "approvalRules/remove",
            Input {
                scope: Scope { scope },
                id,
            },
        )
        .await
    }

    pub async fn auto_review(&self, scope: Option<SettingsScope>) -> Result<AutoReview, Error> {
        self.call("autoReview/get", Scope { scope }).await
    }

    pub async fn set_auto_review(
        &self,
        scope: Option<SettingsScope>,
        mode: ApprovalMode,
    ) -> Result<AutoReview, Error> {
        #[derive(Serialize)]
        struct Input {
            #[serde(flatten)]
            scope: Scope,
            mode: ApprovalMode,
        }
        self.call(
            "autoReview/set",
            Input {
                scope: Scope { scope },
                mode,
            },
        )
        .await
    }

    pub async fn setting_overrides(&self) -> Result<Vec<SpaceSetting>, Error> {
        self.call("spaceSettings/overrides", empty()).await
    }

    pub async fn set_setting_override(
        &self,
        setting: SpaceSetting,
        enabled: bool,
    ) -> Result<Vec<SpaceSetting>, Error> {
        self.call(
            "spaceSettings/setOverride",
            json!({ "setting": setting, "enabled": enabled }),
        )
        .await
    }
}
