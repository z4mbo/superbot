use serde::Deserialize;
use serde_json::json;

use crate::{ComputerMode, Error, SpaceFeatures};

/// The server's `kind` for a deployment that runs no computers for agents.
pub const NO_COMPUTER_KIND: &str = "none";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerState {
    Stopped,
    Booting,
    Running,
    Suspended,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlHolder {
    Bot,
    User,
    None,
}

/// One agent's computer as `computer/status` reports it to this account.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    pub bot_id: String,
    pub mode: ComputerMode,
    /// The provider's opaque kind; [`NO_COMPUTER_KIND`] when the deployment has none.
    pub kind: String,
    pub state: ComputerState,
    pub control_holder: ControlHolder,
    pub takeover_requested: bool,
    pub screen_available: bool,
    /// The agent whose run holds the computer now, if any.
    pub busy_bot_name: Option<String>,
    /// The computer is the person's own machine, which has no remote screen.
    #[serde(default)]
    pub runs_on_user_machine: bool,
    /// Set while the disk is nearly full and the warning has not been dismissed.
    pub disk_full_percent: Option<u8>,
    /// Other people in the Space share this computer.
    #[serde(default)]
    pub shared: bool,
    /// Another person has control, so this viewer only watches.
    #[serde(default)]
    pub controlled_by_other: bool,
    /// This account's own control lease, sent only to the person holding control.
    pub control_lease_id: Option<String>,
    /// The provider gives this computer a terminal, opened by whoever holds control.
    #[serde(default)]
    pub terminal_available: bool,
}

impl ComputerStatus {
    pub fn offered(&self) -> bool {
        self.kind != NO_COMPUTER_KIND
    }
}

/// Whose choice of computer provider a settings read or save is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComputerProviderScope {
    /// Where the deployment's computers run; administrators only.
    Deployment,
    /// Where this account's own computers run, over the deployment's default.
    Account,
}

impl ComputerProviderScope {
    fn path(self, action: &str) -> String {
        match self {
            Self::Deployment => format!("computerProvider/{action}"),
            Self::Account => format!("computerProvider/account/{action}"),
        }
    }
}

/// The provider id that keeps the deployment's own choice.
pub const DEFAULT_COMPUTER_PROVIDER: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFieldKind {
    Text,
    Secret,
    Url,
    Select,
    Toggle,
    List,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProviderFieldOption {
    pub value: String,
    pub label: String,
}

/// One setting a provider asks for, as the server describes it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderField {
    pub key: String,
    pub label: String,
    pub kind: ProviderFieldKind,
    pub required: bool,
    #[serde(default)]
    pub options: Vec<ProviderFieldOption>,
    pub placeholder: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub advanced: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerProviderOption {
    /// Opaque: sent back to choose this provider, never shown or branched on.
    pub id: String,
    pub display_name: String,
    pub fields: Vec<ProviderField>,
}

/// Where computers run and the providers that can be chosen instead. `values` holds the chosen
/// provider's saved settings except secrets, which are only marked as saved.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerProviderSettings {
    pub provider: String,
    pub default_provider: String,
    pub providers: Vec<ComputerProviderOption>,
    pub values: std::collections::BTreeMap<String, String>,
    pub saved_secrets: std::collections::BTreeMap<String, bool>,
}

impl ComputerProviderSettings {
    /// The deployment lets this scope choose: an empty list means it keeps the default.
    pub fn choosable(&self) -> bool {
        !self.providers.is_empty()
    }

    pub fn option(&self, id: &str) -> Option<&ComputerProviderOption> {
        self.providers.iter().find(|option| option.id == id)
    }
}

/// Where to load an agent's screen. The address carries the screen's capability: it is passed
/// only to the screen view and never logged, so this type has no `Debug`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreen {
    pub url: Option<String>,
    pub screen_session: Option<String>,
}

/// Where to open an agent's terminal, with the proof its socket is opened with. Both are
/// capabilities, passed only to the terminal's connection, so this type has no `Debug`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTerminal {
    pub url: Option<String>,
    pub socket_session: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerControl {
    pub lease_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerFileKind {
    File,
    Dir,
}

/// One entry of a folder on an agent's computer. `path` is the server's own spelling: pass it
/// back unchanged to open, preview or download the entry.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ComputerFile {
    pub path: String,
    pub kind: ComputerFileKind,
    pub size: u64,
}

impl ComputerFile {
    pub fn name(&self) -> &str {
        let trimmed = self.path.trim_end_matches('/');
        trimmed.rsplit('/').next().unwrap_or(trimmed)
    }
}

/// The path a file named `name` is uploaded to inside `folder`, a path the server listed.
pub fn computer_file_path(folder: &str, name: &str) -> String {
    let folder = folder.trim_end_matches('/');
    if folder.is_empty() {
        name.to_owned()
    } else {
        format!("{folder}/{name}")
    }
}

#[derive(Deserialize)]
struct ComputerFileText {
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputerFileBytes {
    content_base64: String,
}

impl SpaceFeatures<'_> {
    /// `Err(Error::Server { status: 404, .. })` means the agent has no computer.
    pub async fn computer_status(&self, bot_id: &str) -> Result<ComputerStatus, Error> {
        self.call("computer/status", json!({ "botId": bot_id }))
            .await
    }

    pub async fn start_computer(&self, bot_id: &str) -> Result<ComputerStatus, Error> {
        self.call("computer/boot", json!({ "botId": bot_id })).await
    }

    pub async fn stop_computer(&self, bot_id: &str) -> Result<ComputerStatus, Error> {
        self.call("computer/stop", json!({ "botId": bot_id })).await
    }

    /// The screen to show: interactive while this account holds control, view only otherwise.
    pub async fn computer_screen(&self, bot_id: &str) -> Result<ComputerScreen, Error> {
        self.call(
            "computer/screenUrl",
            json!({ "botId": bot_id, "nativeSession": true }),
        )
        .await
    }

    /// The terminal of a running computer, for the account holding control; `url` is None when
    /// the computer has none.
    pub async fn computer_terminal(&self, bot_id: &str) -> Result<ComputerTerminal, Error> {
        self.call(
            "computer/terminalUrl",
            json!({ "botId": bot_id, "nativeSession": true }),
        )
        .await
    }

    pub async fn take_computer_control(&self, bot_id: &str) -> Result<ComputerControl, Error> {
        self.call("computer/takeover", json!({ "botId": bot_id }))
            .await
    }

    /// Hands back the control `lease_id` names; a late call never ends newer control.
    pub async fn release_computer_control(
        &self,
        bot_id: &str,
        lease_id: &str,
    ) -> Result<(), Error> {
        self.acknowledge(
            "computer/release",
            json!({ "botId": bot_id, "leaseId": lease_id }),
        )
        .await
    }

    /// A folder's entries, `""` for the agent's own top folder. A stopped computer answers from
    /// its saved home.
    pub async fn computer_files(
        &self,
        bot_id: &str,
        path: &str,
    ) -> Result<Vec<ComputerFile>, Error> {
        self.call("computer/files", json!({ "botId": bot_id, "path": path }))
            .await
    }

    /// A text file's words, for a preview. The server refuses binary and large files.
    pub async fn read_computer_file(&self, bot_id: &str, path: &str) -> Result<String, Error> {
        let file: ComputerFileText = self
            .call(
                "computer/readFile",
                json!({ "botId": bot_id, "path": path }),
            )
            .await?;
        Ok(file.content)
    }

    /// A file's bytes as base64, from a running computer only.
    pub async fn download_computer_file(&self, bot_id: &str, path: &str) -> Result<String, Error> {
        let file: ComputerFileBytes = self
            .call(
                "computer/downloadFile",
                json!({ "botId": bot_id, "path": path }),
            )
            .await?;
        Ok(file.content_base64)
    }

    /// Writes a file to a running computer. The server requires this account to hold control.
    pub async fn upload_computer_file(
        &self,
        bot_id: &str,
        path: &str,
        content_base64: &str,
    ) -> Result<(), Error> {
        self.acknowledge(
            "computer/uploadFile",
            json!({ "botId": bot_id, "path": path, "contentBase64": content_base64 }),
        )
        .await
    }

    pub async fn computer_provider_settings(
        &self,
        scope: ComputerProviderScope,
    ) -> Result<ComputerProviderSettings, Error> {
        self.call(&scope.path("get"), json!({})).await
    }

    /// Chooses where computers run. A blank secret keeps the saved one; the server checks the
    /// settings before it keeps them.
    pub async fn save_computer_provider(
        &self,
        scope: ComputerProviderScope,
        provider: &str,
        values: &std::collections::BTreeMap<String, String>,
    ) -> Result<ComputerProviderSettings, Error> {
        self.call(
            &scope.path("update"),
            json!({ "provider": provider, "values": values }),
        )
        .await
    }

    /// Keeps the computer awake, and this account's control alive, while its screen is open.
    pub async fn computer_heartbeat(&self, bot_id: &str) -> Result<(), Error> {
        self.acknowledge("computer/heartbeat", json!({ "botId": bot_id }))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_status_the_server_sends() {
        let status: ComputerStatus = serde_json::from_value(json!({
            "botId": "bot-1",
            "mode": "team",
            "kind": "fake",
            "state": "running",
            "controlHolder": "none",
            "controlBotId": null,
            "takeoverRequested": false,
            "screenAvailable": true,
            "screenWidth": 1280,
            "screenHeight": 800,
            "homeRevision": null,
            "busyBotName": "Scout",
            "canUpdate": false,
            "terminalAvailable": true,
            "diskFullPercent": 93
        }))
        .unwrap();
        assert!(status.offered());
        assert_eq!(status.state, ComputerState::Running);
        assert_eq!(status.busy_bot_name.as_deref(), Some("Scout"));
        assert_eq!(status.disk_full_percent, Some(93));
        assert!(!status.runs_on_user_machine && !status.shared && !status.controlled_by_other);
        assert!(status.terminal_available);
    }

    #[test]
    fn reads_a_folder_listing() {
        let entries: Vec<ComputerFile> = serde_json::from_value(json!([
            { "path": "reports", "kind": "dir", "size": 0 },
            { "path": "reports/q3 plan.md", "kind": "file", "size": 812, "executable": false }
        ]))
        .unwrap();
        assert_eq!(entries[0].kind, ComputerFileKind::Dir);
        assert_eq!(entries[0].name(), "reports");
        assert_eq!(entries[1].name(), "q3 plan.md");
        assert_eq!(entries[1].size, 812);
    }

    #[test]
    fn reads_the_providers_a_deployment_offers() {
        let settings: ComputerProviderSettings = serde_json::from_value(json!({
            "provider": "cloud-a",
            "defaultProvider": "server",
            "providers": [{
                "id": "cloud-a",
                "displayName": "Cloud A",
                "capabilities": { "perAccount": true },
                "fields": [
                    { "key": "apiKey", "label": "API key", "kind": "secret", "required": true },
                    { "key": "region", "label": "Region", "kind": "select", "required": false,
                      "options": [{ "value": "eu", "label": "Europe" }], "advanced": true }
                ]
            }],
            "values": { "region": "eu" },
            "savedSecrets": { "apiKey": true }
        }))
        .unwrap();
        assert!(settings.choosable());
        let option = settings.option("cloud-a").unwrap();
        assert_eq!(option.fields[0].kind, ProviderFieldKind::Secret);
        assert_eq!(option.fields[1].options[0].label, "Europe");
        assert!(option.fields[1].advanced);
        assert_eq!(settings.saved_secrets.get("apiKey"), Some(&true));
        assert_eq!(
            ComputerProviderScope::Account.path("update"),
            "computerProvider/account/update"
        );

        let closed: ComputerProviderSettings = serde_json::from_value(json!({
            "provider": "default", "defaultProvider": "server", "providers": [],
            "values": {}, "savedSecrets": {}
        }))
        .unwrap();
        assert!(!closed.choosable());
    }

    #[test]
    fn an_upload_lands_in_the_folder_on_screen() {
        assert_eq!(computer_file_path("", "notes.txt"), "notes.txt");
        assert_eq!(
            computer_file_path("reports/", "notes.txt"),
            "reports/notes.txt"
        );
        assert_eq!(
            computer_file_path("shared/team", "a b.csv"),
            "shared/team/a b.csv"
        );
    }

    #[test]
    fn a_deployment_without_computers_is_not_offered() {
        let status: ComputerStatus = serde_json::from_value(json!({
            "botId": "bot-1", "mode": "dedicated", "kind": "none", "state": "stopped",
            "controlHolder": "none", "takeoverRequested": false, "screenAvailable": false,
            "busyBotName": null
        }))
        .unwrap();
        assert!(!status.offered());
    }
}
