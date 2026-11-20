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
}

impl ComputerStatus {
    pub fn offered(&self) -> bool {
        self.kind != NO_COMPUTER_KIND
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
        self.call("computer/screenUrl", json!({ "botId": bot_id, "nativeSession": true }))
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
