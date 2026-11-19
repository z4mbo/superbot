use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{threads::TargetInput, Error, SpaceFeatures, ThreadTarget};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub bot_id: Option<String>,
    pub group_id: Option<String>,
    pub run_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub mime_type: String,
    pub size: u64,
    pub version: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub id: String,
    pub version: u64,
    pub name: String,
    pub created_at: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    #[serde(flatten)]
    pub artifact: Artifact,
    pub content_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListItem {
    #[serde(flatten)]
    pub artifact: Artifact,
    pub version_count: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub items: Vec<ArtifactListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactQuery<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub made_by_bots: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadArtifact<'a> {
    pub name: &'a str,
    pub mime_type: &'a str,
    pub content_base64: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_nonce: Option<&'a str>,
}

impl SpaceFeatures<'_> {
    pub async fn list_bot_artifacts(&self, bot_id: &str) -> Result<Vec<Artifact>, Error> {
        self.call("artifacts/list", json!({ "botId": bot_id }))
            .await
    }

    pub async fn list_artifacts(&self, query: &ArtifactQuery<'_>) -> Result<ArtifactPage, Error> {
        self.call("artifacts/listSpace", query).await
    }

    pub async fn artifact_versions(&self, family_id: &str) -> Result<Vec<ArtifactVersion>, Error> {
        self.call("artifacts/listVersions", json!({ "familyId": family_id }))
            .await
    }

    pub async fn upload_artifact(
        &self,
        target: ThreadTarget<'_>,
        fields: &UploadArtifact<'_>,
    ) -> Result<Artifact, Error> {
        self.call("artifacts/create", TargetInput { target, fields })
            .await
    }

    pub async fn artifact(
        &self,
        target: ThreadTarget<'_>,
        id: &str,
    ) -> Result<ArtifactContent, Error> {
        let fields = json!({ "artifactId": id });
        self.call("artifacts/get", TargetInput { target, fields })
            .await
    }

    pub async fn artifact_by_id(&self, id: &str) -> Result<ArtifactContent, Error> {
        self.call("artifacts/getById", json!({ "artifactId": id }))
            .await
    }

    pub async fn remove_artifact(&self, id: &str) -> Result<(), Error> {
        self.acknowledge("artifacts/remove", json!({ "artifactId": id }))
            .await
    }
}
