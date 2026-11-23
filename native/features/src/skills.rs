use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Error, SpaceFeatures};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaughtSkillStatus {
    Recording,
    Drafting,
    Draft,
    Saved,
}

impl TaughtSkillStatus {
    pub fn editable(self) -> bool {
        matches!(self, Self::Draft | Self::Saved)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPlaybook {
    pub when_to_use: String,
    pub inputs: Vec<String>,
    pub steps: Vec<String>,
    pub how_to_check: String,
    pub what_to_return: String,
    pub approval_boundaries: String,
    pub failure_handling: String,
}

/// A skill someone taught one bot by showing it on the bot's computer. The recording itself is
/// left out: only its teacher reads it, and nothing here does.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaughtSkill {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub goal: String,
    pub status: TaughtSkillStatus,
    pub playbook: SkillPlaybook,
    pub created_at: String,
    pub updated_at: String,
}

impl TaughtSkill {
    pub fn title(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.clone();
        }
        self.goal.chars().take(80).collect()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSkillSource {
    User,
    Builtin,
    Plugin,
}

/// A how-to recipe in the Space's skill list, which every bot there can use.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: AgentSkillSource,
    pub read_only: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The whole SKILL.md, front matter included.
    pub content: String,
    pub source: AgentSkillSource,
    pub read_only: bool,
    pub updated_at: String,
}

impl SpaceFeatures<'_> {
    pub async fn taught_skills(&self, bot_id: &str) -> Result<Vec<TaughtSkill>, Error> {
        self.call("skills/list", json!({ "botId": bot_id })).await
    }

    pub async fn taught_skill(&self, skill_id: &str) -> Result<TaughtSkill, Error> {
        self.call("skills/get", json!({ "skillId": skill_id }))
            .await
    }

    pub async fn update_taught_skill(
        &self,
        skill_id: &str,
        name: &str,
        playbook: &SkillPlaybook,
    ) -> Result<TaughtSkill, Error> {
        self.call(
            "skills/updateDraft",
            json!({ "skillId": skill_id, "name": name, "playbook": playbook }),
        )
        .await
    }

    /// Makes a draft a saved skill the bot uses, under `name`.
    pub async fn save_taught_skill(
        &self,
        skill_id: &str,
        name: &str,
    ) -> Result<TaughtSkill, Error> {
        self.call("skills/save", json!({ "skillId": skill_id, "name": name }))
            .await
    }

    /// Asks the bot to run the skill once in its conversation; returns the run's id.
    pub async fn try_taught_skill(&self, skill_id: &str) -> Result<String, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Receipt {
            run_id: String,
        }
        let receipt: Receipt = self
            .call("skills/testRun", json!({ "skillId": skill_id }))
            .await?;
        Ok(receipt.run_id)
    }

    pub async fn remove_taught_skill(&self, skill_id: &str) -> Result<(), Error> {
        self.acknowledge("skills/remove", json!({ "skillId": skill_id }))
            .await
    }

    pub async fn agent_skills(&self) -> Result<Vec<AgentSkillEntry>, Error> {
        self.call("agentSkills/list", crate::empty()).await
    }

    pub async fn agent_skill(&self, skill_id: &str) -> Result<AgentSkill, Error> {
        self.call("agentSkills/get", json!({ "skillId": skill_id }))
            .await
    }

    /// Adds a skill from a whole SKILL.md.
    pub async fn create_agent_skill(&self, content: &str) -> Result<AgentSkill, Error> {
        self.call("agentSkills/create", json!({ "content": content }))
            .await
    }

    pub async fn update_agent_skill(
        &self,
        skill_id: &str,
        content: &str,
    ) -> Result<AgentSkill, Error> {
        self.call(
            "agentSkills/update",
            json!({ "skillId": skill_id, "content": content }),
        )
        .await
    }

    pub async fn remove_agent_skill(&self, skill_id: &str) -> Result<(), Error> {
        self.acknowledge("agentSkills/remove", json!({ "skillId": skill_id }))
            .await
    }
}
