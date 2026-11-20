use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{empty, Error, Patch, SpaceFeatures};

/// The provider id of a connection to any server that speaks a standard
/// model protocol, such as a model server on this machine. Every other
/// provider id is opaque: read its name and needs from its catalog entries.
pub const COMPATIBLE_PROVIDER: &str = "openai-compatible";

/// How a provider lets an account connect, as its catalog entries declare.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderAuth {
    #[default]
    ApiKey,
    Oauth,
    Both,
}

/// An id a provider needs besides its key to route requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutingField {
    AccountId,
    GatewayId,
    ProjectId,
    Region,
    /// A field this client does not know how to fill.
    #[serde(other)]
    Unknown,
}

/// A hosted service offered by name on a compatible connection. It always
/// needs a key.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPreset {
    pub name: String,
    pub base_url: String,
}

/// One model the deployment offers, with the descriptor of its provider.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub provider: String,
    pub provider_name: Option<String>,
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub billing: String,
    pub auth: Option<ProviderAuth>,
    pub oauth_label: Option<String>,
    pub auth_hint: Option<String>,
    /// The provider signs in with an account rather than a key.
    pub sign_in: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    /// Runs through the deployment without a connection of the account's own.
    #[serde(default)]
    pub managed: bool,
    /// Stands in for a provider until a real model id is entered.
    #[serde(default)]
    pub placeholder: bool,
    /// A key can be checked by listing the provider's models.
    #[serde(default)]
    pub catalog_probe: bool,
    #[serde(default)]
    pub routing_fields: Vec<RoutingField>,
    #[serde(default)]
    pub endpoint_presets: Vec<EndpointPreset>,
    /// `chat`, or `decisions` for a model that only reviews actions.
    pub protocol: Option<String>,
    /// How hard the model can be asked to think; empty when it takes no setting.
    #[serde(default)]
    pub thinking_levels: Vec<crate::ThinkingLevel>,
}

impl ModelCatalogEntry {
    pub fn provider_label(&self) -> &str {
        self.provider_name.as_deref().unwrap_or(&self.provider)
    }

    fn chats(&self) -> bool {
        self.protocol.as_deref() != Some("decisions")
    }
}

/// The wire protocol a compatible connection speaks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProtocol {
    #[default]
    ChatCompletions,
    Responses,
    AnthropicMessages,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionAuth {
    ApiKey,
    Oauth,
    OpenaiCompatible,
}

/// One of the account's model connections. Secrets never leave the server;
/// `has_key` only says one is stored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConnection {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub has_key: bool,
    pub is_default: bool,
    pub base_url: Option<String>,
    pub endpoint_name: Option<String>,
    pub api_protocol: Option<ApiProtocol>,
    pub model_id: Option<String>,
    pub enabled_model_ids: Option<Vec<String>>,
    pub auth_kind: Option<ConnectionAuth>,
    /// The provider rejected the stored sign-in; the owner must sign in again.
    #[serde(default)]
    pub reconnect_required: bool,
    pub preference_rank: Option<u32>,
    /// How hard this connection's model can be asked to think; empty when it takes no setting.
    #[serde(default)]
    pub thinking_levels: Vec<crate::ThinkingLevel>,
}

/// A model chosen for a purpose, and the connection it runs on when pinned.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: String,
    pub model_id: String,
    pub credential_id: Option<String>,
    pub credit_offering_id: Option<String>,
}

/// The space's main model: the account's choice, else what the deployment runs.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainModel {
    pub primary: Option<ModelChoice>,
    #[serde(default)]
    pub backups: Vec<ModelChoice>,
    pub deployment_primary: Option<ModelChoice>,
}

impl MainModel {
    /// The model agents without their own run on, if any.
    pub fn running(&self) -> Option<&ModelChoice> {
        self.primary.as_ref().or(self.deployment_primary.as_ref())
    }
}

/// A new connection, or a change to one. The key is sent once and stored
/// sealed on the server; this type deliberately has no `Debug`.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectModel<'a> {
    pub provider: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<ApiProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<&'a str>,
    /// `Clear` adds another connection, `Set` changes that one, `Unchanged`
    /// changes the provider's newest.
    #[serde(skip_serializing_if = "Patch::is_unchanged")]
    pub credential_id: Patch<&'a str>,
    /// Further models a compatible connection serves besides `model_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_model_ids: Option<&'a [&'a str]>,
    /// `Some(false)` keeps the current main model; omitted means it becomes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub make_default: Option<bool>,
}

/// Asks a compatible server which models it serves. Without a key the
/// server reuses the key saved for that address, if any.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeServer<'a> {
    pub base_url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<ApiProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct FoundModels {
    models: Vec<String>,
}

impl SpaceFeatures<'_> {
    /// Every model the deployment offers, connected or not, with its provider's descriptor.
    pub async fn model_catalog(&self) -> Result<Vec<ModelCatalogEntry>, Error> {
        self.call("models/list", empty()).await
    }

    pub async fn model_connections(&self) -> Result<Vec<ModelConnection>, Error> {
        self.call("models/credentials", empty()).await
    }

    pub async fn main_model(&self) -> Result<MainModel, Error> {
        self.call("models/role", json!({ "role": "main" })).await
    }

    /// Saves a connection after the server has checked it with the provider.
    pub async fn connect_model(&self, input: &ConnectModel<'_>) -> Result<ModelConnection, Error> {
        self.call("models/connect", input).await
    }

    pub async fn probe_server_models(&self, input: &ProbeServer<'_>) -> Result<Vec<String>, Error> {
        let found: FoundModels = self.call("models/probeOpenAiCompatible", input).await?;
        Ok(found.models)
    }

    /// Checks a key against a provider whose entries have `catalog_probe`.
    pub async fn probe_provider_models(
        &self,
        provider: &str,
        api_key: &str,
    ) -> Result<Vec<String>, Error> {
        let found: FoundModels = self
            .call(
                "models/probeCatalog",
                json!({ "provider": provider, "apiKey": api_key }),
            )
            .await?;
        Ok(found.models)
    }

    /// Makes `option` the main model, on the connection it came from.
    pub async fn set_main_model(&self, option: &ModelOption) -> Result<MainModel, Error> {
        let mut primary = json!({ "provider": option.provider, "modelId": option.model_id });
        if let Some(credential_id) = &option.credential_id {
            primary["credentialId"] = json!(credential_id);
        }
        self.call(
            "models/setRole",
            json!({ "role": "main", "primary": primary }),
        )
        .await
    }

    /// Removes one connection from the account, in every space.
    pub async fn disconnect_model(&self, provider: &str, credential_id: &str) -> Result<(), Error> {
        self.acknowledge(
            "models/disconnect",
            json!({ "provider": provider, "credentialId": credential_id }),
        )
        .await
    }
}

/// How a provider is connected from a native client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectMethod {
    /// A server address, an optional key and one of the models it serves.
    Server,
    /// A key, any routing ids, and a model from the catalog.
    Key,
    /// Only an account sign-in, which the web app completes.
    SignIn,
}

/// A provider as the catalog describes it: the first entry per provider id
/// carries the descriptor, the rest are its models.
#[derive(Clone, Debug)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub method: ConnectMethod,
    /// The provider also offers an account sign-in.
    pub sign_in: bool,
    pub sign_in_label: Option<String>,
    pub hint: Option<String>,
    pub catalog_probe: bool,
    pub routing_fields: Vec<RoutingField>,
    pub endpoint_presets: Vec<EndpointPreset>,
    /// Real models, with the recommended one first.
    pub models: Vec<ModelCatalogEntry>,
}

impl ModelProvider {
    /// A key connection can be saved natively only when every routing id is
    /// one this client can fill.
    pub fn native(&self) -> bool {
        self.method != ConnectMethod::SignIn
            && !self.routing_fields.contains(&RoutingField::Unknown)
    }
}

/// The providers an account can connect, compatible servers first and the
/// rest by name. Managed-only and decision-only entries are left out.
pub fn model_providers(catalog: &[ModelCatalogEntry]) -> Vec<ModelProvider> {
    let mut providers: Vec<ModelProvider> = Vec::new();
    for entry in catalog
        .iter()
        .filter(|entry| entry.chats() && !entry.managed)
    {
        let provider = match providers.iter_mut().find(|p| p.id == entry.provider) {
            Some(provider) => provider,
            None => {
                let method = if entry.provider == COMPATIBLE_PROVIDER {
                    ConnectMethod::Server
                } else if entry.auth == Some(ProviderAuth::Oauth) {
                    ConnectMethod::SignIn
                } else {
                    ConnectMethod::Key
                };
                providers.push(ModelProvider {
                    id: entry.provider.clone(),
                    name: entry.provider_label().to_owned(),
                    method,
                    sign_in: entry.sign_in.is_some()
                        || matches!(entry.auth, Some(ProviderAuth::Oauth | ProviderAuth::Both)),
                    sign_in_label: entry.oauth_label.clone(),
                    hint: entry.auth_hint.clone(),
                    catalog_probe: entry.catalog_probe,
                    routing_fields: entry.routing_fields.clone(),
                    endpoint_presets: entry.endpoint_presets.clone(),
                    models: Vec::new(),
                });
                providers.last_mut().expect("just pushed")
            }
        };
        if !entry.placeholder {
            provider.models.push(entry.clone());
        }
    }
    for provider in &mut providers {
        provider.models.sort_by_key(|model| !model.recommended);
    }
    providers.sort_by(|a, b| {
        (a.method != ConnectMethod::Server)
            .cmp(&(b.method != ConnectMethod::Server))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    providers
}

/// A model an agent can be set to: one a connection runs, or one the
/// deployment provides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOption {
    pub provider: String,
    pub model_id: String,
    pub label: String,
    /// The connection or provider name it runs on.
    pub source: String,
    /// The connection it runs on; `None` for the deployment's own models.
    pub credential_id: Option<String>,
}

impl ModelOption {
    pub fn is(&self, provider: &str, model_id: &str) -> bool {
        self.provider == provider && self.model_id == model_id
    }
}

/// The models the account's connections can run, then the deployment's own,
/// each once. A connection with enabled ids offers those; one whose saved
/// model the catalog does not list offers that model; any other offers its
/// provider's catalog models.
pub fn model_options(
    connections: &[ModelConnection],
    catalog: &[ModelCatalogEntry],
) -> Vec<ModelOption> {
    let catalog_option = |entry: &ModelCatalogEntry, credential_id: Option<&str>| ModelOption {
        provider: entry.provider.clone(),
        model_id: entry.id.clone(),
        label: entry.label.clone(),
        source: entry.provider_label().to_owned(),
        credential_id: credential_id.map(str::to_owned),
    };
    let mut options = Vec::new();
    for connection in connections {
        let listed: Vec<&ModelCatalogEntry> = catalog
            .iter()
            .filter(|entry| {
                entry.provider == connection.provider && !entry.placeholder && entry.chats()
            })
            .collect();
        let own = |model_id: &str| {
            let known = listed.iter().find(|entry| entry.id == model_id);
            ModelOption {
                provider: connection.provider.clone(),
                model_id: model_id.to_owned(),
                label: known.map_or_else(|| model_id.to_owned(), |entry| entry.label.clone()),
                source: connection.label.clone(),
                credential_id: Some(connection.id.clone()),
            }
        };
        let enabled: Vec<&str> = connection
            .enabled_model_ids
            .iter()
            .flatten()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .collect();
        let saved = connection
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if !enabled.is_empty() {
            options.extend(enabled.into_iter().map(own));
        } else if let Some(saved) = saved.filter(|id| !listed.iter().any(|e| e.id == *id)) {
            options.push(own(saved));
        } else {
            options.extend(
                listed
                    .into_iter()
                    .map(|entry| catalog_option(entry, Some(&connection.id))),
            );
        }
    }
    options.extend(
        catalog
            .iter()
            .filter(|entry| entry.managed && !entry.placeholder && entry.chats())
            .map(|entry| catalog_option(entry, None)),
    );
    let mut seen = HashSet::new();
    options.retain(|option| seen.insert((option.provider.clone(), option.model_id.clone())));
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: &str, id: &str, extra: serde_json::Value) -> ModelCatalogEntry {
        let mut value = json!({
            "provider": provider,
            "providerName": format!("{provider} name"),
            "id": id,
            "label": format!("{id} label"),
            "billing": "",
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn connection(provider: &str, extra: serde_json::Value) -> ModelConnection {
        let mut value = json!({
            "id": format!("{provider}-connection"),
            "provider": provider,
            "label": format!("{provider} connection"),
            "hasKey": true,
            "isDefault": false,
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn thinking_levels_are_read_and_absent_on_older_servers() {
        let levels = json!({ "thinkingLevels": ["low", "high", "xhigh"] });
        assert_eq!(
            entry("alpha", "a-1", levels.clone()).thinking_levels,
            [crate::ThinkingLevel::Low, crate::ThinkingLevel::High, crate::ThinkingLevel::Xhigh]
        );
        assert_eq!(
            connection("alpha", levels).thinking_levels,
            [crate::ThinkingLevel::Low, crate::ThinkingLevel::High, crate::ThinkingLevel::Xhigh]
        );
        assert!(entry("alpha", "a-1", json!({})).thinking_levels.is_empty());
        assert!(connection("alpha", json!({})).thinking_levels.is_empty());
    }

    #[test]
    fn providers_come_from_their_descriptors_with_servers_first() {
        let catalog = [
            entry("zeta", "z-1", json!({})),
            entry(
                "alpha",
                "a-1",
                json!({ "auth": "oauth", "oauthLabel": "Sign in" }),
            ),
            entry("zeta", "z-2", json!({ "recommended": true })),
            entry(
                COMPATIBLE_PROVIDER,
                "custom",
                json!({ "placeholder": true,
                "endpointPresets": [{ "name": "Hosted", "baseUrl": "https://hosted.example/v1" }] }),
            ),
            entry(
                "beta",
                "b-1",
                json!({ "auth": "both", "routingFields": ["accountId", "tenant"] }),
            ),
            entry("managed", "m-1", json!({ "managed": true })),
            entry("review", "r-1", json!({ "protocol": "decisions" })),
        ];
        let providers = model_providers(&catalog);
        let ids: Vec<&str> = providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [COMPATIBLE_PROVIDER, "alpha", "beta", "zeta"]);

        let server = &providers[0];
        assert_eq!(server.method, ConnectMethod::Server);
        assert!(server.models.is_empty(), "placeholders are not models");
        assert_eq!(server.endpoint_presets[0].name, "Hosted");

        assert_eq!(providers[1].method, ConnectMethod::SignIn);
        assert!(!providers[1].native());

        let beta = &providers[2];
        assert_eq!(beta.method, ConnectMethod::Key);
        assert!(beta.sign_in);
        assert_eq!(
            beta.routing_fields,
            [RoutingField::AccountId, RoutingField::Unknown]
        );
        assert!(!beta.native(), "an unknown routing id goes to the web app");

        let zeta = &providers[3];
        assert!(zeta.native());
        let models: Vec<&str> = zeta.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(models, ["z-2", "z-1"], "the recommended model comes first");
    }

    #[test]
    fn options_follow_what_each_connection_runs() {
        let catalog = [
            entry("keyed", "k-1", json!({})),
            entry("keyed", "k-2", json!({})),
            entry(
                COMPATIBLE_PROVIDER,
                "custom",
                json!({ "placeholder": true }),
            ),
            entry("hosted", "h-1", json!({ "managed": true })),
            entry("unconnected", "u-1", json!({})),
        ];
        let connections = [
            connection("keyed", json!({ "modelId": "k-1" })),
            connection(
                COMPATIBLE_PROVIDER,
                json!({ "modelId": "local-a", "enabledModelIds": ["local-a", " local-b ", ""] }),
            ),
            connection("custom-id", json!({ "modelId": "typed-model" })),
        ];
        let options = model_options(&connections, &catalog);
        let keys: Vec<(&str, &str)> = options
            .iter()
            .map(|o| (o.provider.as_str(), o.model_id.as_str()))
            .collect();
        assert_eq!(
            keys,
            [
                ("keyed", "k-1"),
                ("keyed", "k-2"),
                (COMPATIBLE_PROVIDER, "local-a"),
                (COMPATIBLE_PROVIDER, "local-b"),
                ("custom-id", "typed-model"),
                ("hosted", "h-1"),
            ]
        );
        assert_eq!(options[0].label, "k-1 label");
        assert_eq!(options[0].source, "keyed name");
        assert_eq!(options[2].source, "openai-compatible connection");
        assert_eq!(options[2].label, "local-a");
        assert_eq!(
            options[0].credential_id.as_deref(),
            Some("keyed-connection")
        );
        assert_eq!(
            options[5].credential_id, None,
            "the deployment's models need no pin"
        );
    }

    #[test]
    fn a_new_connection_says_so_and_a_key_is_sent_once() {
        let input = ConnectModel {
            provider: COMPATIBLE_PROVIDER,
            base_url: Some("http://127.0.0.1:11434/v1"),
            api_protocol: Some(ApiProtocol::ChatCompletions),
            model_id: Some("local-a"),
            label: Some("Local"),
            credential_id: Patch::Clear,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            json!({
                "provider": COMPATIBLE_PROVIDER,
                "baseUrl": "http://127.0.0.1:11434/v1",
                "apiProtocol": "chat-completions",
                "modelId": "local-a",
                "label": "Local",
                "credentialId": null,
            })
        );
    }

    #[test]
    fn the_main_model_falls_back_to_the_deployment() {
        let view: MainModel = serde_json::from_value(json!({
            "primary": null,
            "backups": [],
            "deploymentPrimary": { "provider": "hosted", "modelId": "h-1" },
        }))
        .unwrap();
        assert_eq!(view.running().unwrap().model_id, "h-1");
    }
}
