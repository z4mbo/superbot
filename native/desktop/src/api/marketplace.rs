use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use superbot_client::Error;

use super::Api;

/// A plugin a registry on this server lists, installed from its repository.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub source: String,
    pub installed_source: String,
    /// Installing adds a remote connector; without one the plugin is a pack of skills.
    pub has_connector: bool,
    pub skill_count: u32,
    /// The plugin's logo, when its registry names one.
    #[serde(default)]
    pub logo: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCatalog {
    pub entries: Vec<MarketplaceEntry>,
    /// Registries that could not be read this time, so the list may be short.
    pub unavailable_registries: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginPart {
    Connector,
    Skills,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct PreviewSkill {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct PreviewServer {
    pub name: String,
    pub endpoint: String,
}

/// A part of the repository this server cannot add, with the reason it gives.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Skipped {
    pub kind: String,
    pub name: String,
    pub reason: String,
}

/// What installing a plugin repository would add, read without installing it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreview {
    pub name: String,
    pub description: String,
    pub digest: String,
    /// The immutable source an install of exactly this preview confirms.
    #[serde(default)]
    pub pinned_source: Option<String>,
    #[serde(default)]
    pub installed_source: Option<String>,
    pub skills: Vec<PreviewSkill>,
    pub mcp_servers: Vec<PreviewServer>,
    pub skipped: Vec<Skipped>,
}

impl PluginPreview {
    /// The parts this server can add from the repository.
    pub fn parts(&self) -> Vec<PluginPart> {
        let mut parts = Vec::new();
        if !self.mcp_servers.is_empty() {
            parts.push(PluginPart::Connector);
        }
        if !self.skills.is_empty() {
            parts.push(PluginPart::Skills);
        }
        parts
    }

    /// The parts that need a client this app is not, such as a local command or an editor.
    pub fn elsewhere(&self) -> impl Iterator<Item = &Skipped> {
        self.skipped.iter().filter(|skipped| skipped.kind != "unsupported_field")
    }
}

/// A plugin installed in this Space, from `capabilities.list`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstall {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub source: String,
    pub config: Map<String, Value>,
}

impl PluginInstall {
    /// The parts it added. Installs from before parts could be chosen added everything.
    pub fn parts(&self) -> Vec<PluginPart> {
        self.config
            .get("parts")
            .and_then(|parts| serde_json::from_value(parts.clone()).ok())
            .unwrap_or_else(|| vec![PluginPart::Connector, PluginPart::Skills])
    }

    /// The skills it added, from the preview the server saved with the install.
    pub fn skill_names(&self) -> Vec<String> {
        let Some(Value::Array(skills)) = self.config.get("skills") else { return Vec::new() };
        skills.iter().filter_map(|skill| skill.get("name")?.as_str().map(str::to_owned)).collect()
    }

    pub fn installs(&self, entry: &MarketplaceEntry) -> bool {
        self.kind == "plugin" && self.source == entry.installed_source
    }
}

impl Api {
    pub async fn marketplace(&self, space_id: &str, query: &str) -> Result<MarketplaceCatalog, Error> {
        self.client.rpc("marketplace/catalog", Some(space_id), json!({ "query": query })).await
    }

    /// Reads the repository and says what an install would add, without installing.
    pub async fn preview_plugin(&self, space_id: &str, source: &str) -> Result<PluginPreview, Error> {
        self.client.rpc("capabilities/pluginPreview", Some(space_id), json!({ "source": source })).await
    }

    pub async fn plugin_installs(&self, space_id: &str) -> Result<Vec<PluginInstall>, Error> {
        let installs: Vec<PluginInstall> = self.client.rpc("capabilities/list", Some(space_id), json!({})).await?;
        Ok(installs.into_iter().filter(|install| install.kind == "plugin").collect())
    }

    /// Installs exactly the previewed content: the server refuses when the repository changed.
    pub async fn install_plugin_parts(
        &self,
        space_id: &str,
        preview: &PluginPreview,
        source: &str,
        parts: &[PluginPart],
    ) -> Result<PluginInstall, Error> {
        let input = json!({
            "kind": "plugin",
            "name": preview.name,
            "source": preview.pinned_source.as_deref().unwrap_or(source),
            "pluginDigest": preview.digest,
            "config": {},
            "pluginParts": parts,
        });
        self.client.rpc("capabilities/install", Some(space_id), input).await
    }

    /// Changes which parts an installed plugin keeps at its pinned version; no parts removes it.
    pub async fn set_plugin_parts(&self, space_id: &str, install_id: &str, parts: &[PluginPart]) -> Result<(), Error> {
        self.done("capabilities/pluginParts", space_id, json!({ "id": install_id, "parts": parts })).await
    }
}

/// A name reduced to its letters and digits, lowercased, so one brand reads the same in every
/// catalog: "Google Calendar", "google-calendar" and "GoogleCalendar".
pub fn brand(name: &str) -> String {
    name.chars().filter(|letter| letter.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

impl MarketplaceEntry {
    /// Whether this plugin is the same brand as a service named `name`.
    pub fn is_brand(&self, name: &str) -> bool {
        let name = brand(name);
        !name.is_empty() && (brand(&self.display_name) == name || brand(&self.name) == name)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{MarketplaceEntry, PluginInstall, PluginPart, PluginPreview};

    #[test]
    fn a_preview_offers_the_parts_this_server_can_add() {
        let preview: PluginPreview = serde_json::from_value(json!({
            "format": "cursor", "name": "tracker", "version": null, "description": "Issues",
            "author": null, "homepage": null, "repository": null, "license": null, "keywords": [],
            "resolvedSha": "0".repeat(40), "digest": format!("sha256:{}", "0".repeat(64)),
            "skills": [{ "name": "triage", "description": "Sort issues" }],
            "mcpServers": [],
            "skipped": [
                { "kind": "mcp_stdio", "name": "local", "reason": "Runs a local command" },
                { "kind": "unsupported_field", "name": "hooks", "reason": "Ignored" }
            ]
        }))
        .unwrap();
        assert_eq!(preview.parts(), vec![PluginPart::Skills]);
        assert_eq!(preview.elsewhere().map(|skipped| skipped.name.as_str()).collect::<Vec<_>>(), ["local"]);
        assert_eq!(preview.pinned_source, None);
    }

    #[test]
    fn an_older_install_has_every_part() {
        let install: PluginInstall = serde_json::from_value(json!({
            "id": "i1", "kind": "plugin", "name": "tracker", "source": "https://example.test/repo",
            "version": null, "digest": null, "secretConfigured": false, "config": {}, "createdAt": "x"
        }))
        .unwrap();
        assert_eq!(install.parts(), vec![PluginPart::Connector, PluginPart::Skills]);
        let chosen = PluginInstall { config: json!({ "parts": ["skills"] }).as_object().unwrap().clone(), ..install };
        assert_eq!(chosen.parts(), vec![PluginPart::Skills]);
    }

    #[test]
    fn one_brand_matches_in_any_spelling() {
        let entry = MarketplaceEntry {
            id: "Cursor:google-calendar".into(),
            name: "google-calendar".into(),
            display_name: "Google Calendar".into(),
            description: String::new(),
            source: String::new(),
            installed_source: String::new(),
            has_connector: true,
            skill_count: 0,
            logo: None,
        };
        assert!(entry.is_brand("GoogleCalendar"));
        assert!(entry.is_brand("google_calendar"));
        assert!(!entry.is_brand("Calendar"));
        assert!(!entry.is_brand("—"));
    }
}
