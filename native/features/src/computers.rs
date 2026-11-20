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
