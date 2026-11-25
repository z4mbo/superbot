use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use superbot_client::{Client, Error, ThreadEvent, ThreadTarget, SERVER_UNREACHABLE};

mod apps;
mod connections;
mod marketplace;
mod sources;

pub use apps::{AppRecord, RecordQuery};
pub use connections::{next_account_label, CatalogApp, Connection, ConnectionStatus};
pub use marketplace::{MarketplaceCatalog, MarketplaceEntry, PluginInstall, PluginPart, PluginPreview};
pub use sources::{
    same_endpoint, Assignment, McpServer, OAuthStatus, ServerState, SignInStart, SourceInstall, SourcePreset,
    OAUTH_CLIENT_REQUIRED,
};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// An agent's first conversation, the one the sidebar and every older client open.
    Agent(String),
    Group(String),
    /// Another conversation with an agent, started with New conversation.
    Conversation {
        agent: String,
        thread: String,
    },
}

impl Target {
    pub fn wire(&self) -> ThreadTarget<'_> {
        match self {
            Self::Agent(id) => ThreadTarget::Bot(id),
            Self::Group(id) => ThreadTarget::Group(id),
            Self::Conversation { agent, thread } => ThreadTarget::BotConversation { bot_id: agent, thread_id: thread },
        }
    }

    /// The agent this conversation is with, whichever of its conversations it is.
    pub fn agent(&self) -> Option<&str> {
        match self {
            Self::Agent(id) | Self::Conversation { agent: id, .. } => Some(id),
            Self::Group(_) => None,
        }
    }

    /// Where this conversation's unsaved local turn is kept: the agent's own key for its first
    /// conversation, a thread key for the others, so two conversations never share one.
    pub fn local_key(&self) -> Option<String> {
        match self {
            Self::Agent(id) => Some(id.clone()),
            Self::Conversation { thread, .. } => Some(format!("thread:{thread}")),
            Self::Group(_) => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    /// Empty only from a server that does not send it; the workspace window then opens the browser.
    #[serde(default)]
    pub user_id: String,
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default)]
    pub needs_model: bool,
    /// The largest file this server stores, when it says.
    #[serde(default)]
    pub max_upload_size_bytes: Option<u64>,
    /// The most files one message may carry, when the server says.
    #[serde(default)]
    pub max_attachments_per_message: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Navigation {
    pub current: CurrentSpace,
    pub spaces: Vec<SpaceSummary>,
}

impl Navigation {
    fn preferred_shared_space(&self) -> Option<&str> {
        if self.spaces.iter().any(|space| space.id == self.current.id && space.shared) {
            return None;
        }
        self.spaces.iter().find(|space| space.shared).map(|space| space.id.as_str())
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn initial_navigation_prefers_an_accessible_shared_space() {
        let navigation: Navigation = serde_json::from_value(json!({
            "current": { "id": "personal", "name": "Personal" },
            "spaces": [
                { "id": "personal", "name": "Personal", "shared": false },
                { "id": "named-team", "name": "Team" },
                { "id": "guest-space", "name": "Guest Space", "shared": true },
                { "id": "another-shared", "name": "Research", "shared": true }
            ]
        }))
        .unwrap();
        assert_eq!(navigation.preferred_shared_space(), Some("guest-space"));
    }

    #[test]
    fn the_current_space_names_its_roster_sections_and_each_bot_its_own() {
        let navigation: Navigation = serde_json::from_value(json!({
            "current": {
                "id": "personal", "name": "Personal",
                "bots": [{ "id": "a", "name": "A", "sectionId": "work" }, { "id": "b", "name": "B" }],
                "botSections": [{ "id": "work", "name": "Work" }]
            },
            "spaces": [{ "id": "personal", "name": "Personal" }]
        }))
        .unwrap();
        assert_eq!(navigation.current.bot_sections[0].name, "Work");
        assert_eq!(navigation.current.bots[0].section_id.as_deref(), Some("work"));
        assert_eq!(navigation.current.bots[1].section_id, None);
    }

    #[test]
    fn initial_navigation_retains_the_current_shared_space_or_private_fallback() {
        let mut navigation: Navigation = serde_json::from_value(json!({
            "current": { "id": "current", "name": "Research" },
            "spaces": [
                { "id": "other", "name": "Other", "shared": true },
                { "id": "current", "name": "Research", "shared": true }
            ]
        }))
        .unwrap();
        assert_eq!(navigation.preferred_shared_space(), None);
        navigation.spaces.remove(0);
        navigation.spaces[0].shared = false;
        assert_eq!(navigation.preferred_shared_space(), None);
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct CurrentSpace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub bots: Vec<AgentSummary>,
    #[serde(default)]
    pub groups: Vec<GroupSummary>,
    /// The roster's named sections, in order; bots name theirs by `sectionId`.
    #[serde(default, rename = "botSections")]
    pub bot_sections: Vec<BotSection>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BotSection {
    pub id: String,
    pub name: String,
}

pub type SpaceSummary = superbot_client::Space;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    /// Avatar shape and colour picked for this agent, by pack names.
    #[serde(default)]
    pub look_shape: Option<String>,
    #[serde(default)]
    pub look_color: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// The roster section this bot is filed under, if any.
    #[serde(default)]
    pub section_id: Option<String>,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub thread_status: Option<String>,
}

impl AgentSummary {
    pub fn working(&self) -> bool {
        matches!(self.thread_status.as_deref().unwrap_or(&self.status), "queued" | "leased" | "running")
    }

    pub fn waiting_on_you(&self) -> bool {
        matches!(self.thread_status.as_deref().unwrap_or(&self.status), "waiting_input" | "waiting_takeover")
    }

    pub fn avatar(&self) -> superbot_avatars::Bot<'_> {
        superbot_avatars::Bot {
            id: &self.id,
            name: &self.name,
            color: &self.color,
            picked: superbot_avatars::Picked { shape: self.look_shape.as_deref(), color: self.look_color.as_deref() },
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    #[serde(default)]
    pub bot_id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
}

impl GroupMember {
    pub fn avatar(&self) -> superbot_avatars::Bot<'_> {
        superbot_avatars::Bot { id: &self.bot_id, name: &self.name, color: &self.color, picked: Default::default() }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<GroupMember>,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub preview: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Author {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMessage {
    pub id: String,
    /// The message's place in its conversation. History always states it; the live stream
    /// states it for some messages only.
    #[serde(default)]
    pub seq: Option<i64>,
    pub role: String,
    #[serde(default)]
    pub blocks: Vec<Value>,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub author: Option<Author>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    /// When the server stored the message, as RFC 3339.
    #[serde(default)]
    pub created_at: Option<String>,
    /// The words this message answers, quoted from an earlier one.
    #[serde(default)]
    pub reply_quote: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub status: String,
    #[serde(default)]
    pub id: Option<String>,
    /// Who started the run: only they answer its cards.
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cursor: i64,
    pub messages: Vec<WireMessage>,
    /// Where the page before this one starts, when there is one.
    #[serde(default)]
    pub older_cursor: Option<u64>,
    /// A group's bots, in the order the server keeps them.
    #[serde(default)]
    pub members: Option<Vec<GroupMember>>,
    #[serde(default)]
    pub run: Option<Run>,
    #[serde(default)]
    pub active_runs: Option<Vec<Run>>,
}

/// One page of history older than what is on screen.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<WireMessage>,
    #[serde(default)]
    pub older_cursor: Option<u64>,
}

/// A message to send. The nonce names this one message: sent again with the same nonce, the
/// server keeps a single copy.
pub struct Outgoing<'a> {
    pub text: Option<&'a str>,
    pub artifact_ids: &'a [String],
    /// The group's bots this message names.
    pub mentions: &'a [String],
    pub nonce: &'a str,
}

/// A stored file's bytes, read through the conversation it belongs to.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub name: String,
    pub mime_type: String,
    pub content_base64: String,
}

impl Snapshot {
    pub fn working(&self) -> bool {
        let active = |run: &Run| matches!(run.status.as_str(), "queued" | "leased" | "running");
        self.run.as_ref().is_some_and(active) || self.active_runs.as_ref().is_some_and(|runs| runs.iter().any(active))
    }
}

/// A message arriving on the live stream, in the same shape as one read from history.
pub fn message_from_event(event: &ThreadEvent) -> Option<WireMessage> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        message_id: String,
        seq: Option<i64>,
        role: Option<String>,
        #[serde(default)]
        blocks: Vec<Value>,
        #[serde(default)]
        bot_id: Option<String>,
        #[serde(default)]
        author: Option<Author>,
        origin: Option<String>,
        #[serde(default)]
        reply_quote: Option<String>,
    }
    let payload: Payload = serde_json::from_value(event.data.clone()).ok()?;
    let role = payload.role.unwrap_or_else(|| "bot".into());
    // A bot's reply names its bot on the event, not in the message.
    let speaking_bot =
        if role == "bot" && payload.origin.as_deref() != Some("local_cli") { event.bot_id.clone() } else { None };
    Some(WireMessage {
        id: payload.message_id,
        seq: payload.seq,
        role,
        blocks: payload.blocks,
        bot_id: payload.bot_id.or(speaking_bot),
        author: payload.author,
        origin: payload.origin,
        run_id: event.run_id.clone(),
        created_at: None,
        reply_quote: payload.reply_quote,
    })
}

pub use superbot_features::plugin_manifest::{
    AppField, AppFieldKind, PluginManifest as Manifest, PluginPart as ManifestPart,
};

#[derive(Clone, Debug, Deserialize)]
pub struct PluginVersion {
    pub id: String,
    pub slug: String,
    pub version: i64,
    pub manifest: Manifest,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub bot_id: String,
    pub part_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Installation {
    pub id: String,
    pub plugin: PluginVersion,
    #[serde(default)]
    pub grants: Vec<Grant>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    next_after: Option<String>,
}

/// Every Superbot call the interface makes, bound to one signed-in session.
#[derive(Clone)]
pub struct Api {
    pub client: Client,
    /// This session's control of agents' computers; it ends with the session.
    pub controls: crate::control::Controls,
}

impl Api {
    pub fn new(client: Client) -> Self {
        Self { client, controls: crate::control::Controls::default() }
    }

    pub async fn me(&self) -> Result<Me, Error> {
        self.client.rpc("me", None, json!({})).await
    }

    pub async fn navigation(&self, space_id: Option<&str>) -> Result<Navigation, Error> {
        let mut navigation = self.space_navigation(space_id).await?;
        navigation.spaces = self.client.include_other_spaces(space_id, navigation.spaces).await?;
        Ok(navigation)
    }

    pub async fn space_navigation(&self, space_id: Option<&str>) -> Result<Navigation, Error> {
        self.client.rpc("spaces/list", space_id, json!({})).await
    }

    pub async fn initial_navigation(&self) -> Result<Navigation, Error> {
        let mut navigation = self.navigation(None).await?;
        if let Some(space_id) = navigation.preferred_shared_space() {
            match self.client.rpc::<Navigation>("spaces/list", Some(space_id), json!({})).await {
                Ok(shared) => navigation.current = shared.current,
                Err(Error::Server { status: 403 | 404, .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(navigation)
    }

    pub async fn create_space(&self, name: &str) -> Result<SpaceSummary, Error> {
        self.client.rpc("spaces/create", None, json!({ "name": name })).await
    }

    pub async fn create_agent(&self, space_id: &str, name: &str) -> Result<AgentSummary, Error> {
        self.client.rpc("bots/create", Some(space_id), json!({ "name": name })).await
    }

    pub async fn update_agent(&self, space_id: &str, agent_id: &str, patch: Value) -> Result<AgentSummary, Error> {
        let mut input = json!({ "botId": agent_id });
        if let (Some(input), Some(patch)) = (input.as_object_mut(), patch.as_object()) {
            input.extend(patch.clone());
        }
        self.client.rpc("bots/update", Some(space_id), input).await
    }

    pub async fn archive_agent(&self, space_id: &str, agent_id: &str) -> Result<(), Error> {
        self.done("bots/archive", space_id, json!({ "botId": agent_id })).await
    }

    pub async fn restore_agent(&self, space_id: &str, agent_id: &str) -> Result<(), Error> {
        self.done("bots/restore", space_id, json!({ "botId": agent_id })).await
    }

    pub async fn snapshot(&self, space_id: &str, target: &Target) -> Result<Snapshot, Error> {
        self.client.rpc("threads/get", Some(space_id), json!(target.wire())).await
    }

    /// The page of history that ends just before message `before`.
    pub async fn older(&self, space_id: &str, target: &Target, before: u64) -> Result<MessagePage, Error> {
        let mut input = json!(target.wire());
        input["before"] = json!(before);
        self.client.rpc("threads/messages", Some(space_id), input).await
    }

    pub async fn send(&self, space_id: &str, target: &Target, message: &Outgoing<'_>) -> Result<(), Error> {
        self.client.rpc::<Value>("threads/send", Some(space_id), send_input(target, message)).await.map(|_| ())
    }

    /// Stores a file in the conversation and returns its id. Sent again with the same nonce,
    /// the server answers with the file it already stored.
    pub async fn upload(
        &self,
        space_id: &str,
        target: &Target,
        name: &str,
        mime_type: &str,
        content_base64: &str,
        nonce: &str,
    ) -> Result<String, Error> {
        #[derive(Deserialize)]
        struct Stored {
            id: String,
        }
        let mut input = json!(target.wire());
        input["name"] = json!(name);
        input["mimeType"] = json!(mime_type);
        input["contentBase64"] = json!(content_base64);
        input["clientNonce"] = json!(nonce);
        let stored: Stored = self.client.rpc("artifacts/create", Some(space_id), input).await?;
        Ok(stored.id)
    }

    /// Reads a file through the conversation it was sent in, so the server checks that it
    /// belongs there.
    pub async fn file(&self, space_id: &str, target: &Target, artifact_id: &str) -> Result<FileContent, Error> {
        let mut input = json!(target.wire());
        input["artifactId"] = json!(artifact_id);
        self.client.rpc("artifacts/get", Some(space_id), input).await
    }

    pub async fn stop(&self, space_id: &str, target: &Target) -> Result<(), Error> {
        self.done("threads/stop", space_id, json!(target.wire())).await
    }

    pub async fn mark_read(&self, space_id: &str, target: &Target) -> Result<(), Error> {
        self.done("threads/markRead", space_id, json!(target.wire())).await
    }

    pub async fn answer_card(
        &self,
        space_id: &str,
        target: &Target,
        run_id: &str,
        message_id: &str,
        answer: &str,
    ) -> Result<(), Error> {
        let mut input = json!(target.wire());
        input["runId"] = json!(run_id);
        input["messageId"] = json!(message_id);
        input["answer"] = json!(answer);
        self.done("threads/answer", space_id, input).await
    }

    /// Answers a question card; `dismiss` turns down a secret request with an empty answer.
    pub async fn answer_question(
        &self,
        space_id: &str,
        target: &Target,
        run_id: &str,
        message_id: &str,
        answer: &str,
        dismiss: bool,
    ) -> Result<(), Error> {
        let mut input = json!(target.wire());
        input["runId"] = json!(run_id);
        input["messageId"] = json!(message_id);
        input["answer"] = json!(answer);
        if dismiss {
            input["dismiss"] = json!(true);
        }
        self.done("threads/answer", space_id, input).await
    }

    /// Picks an option on the first-run focus card, or puts it away with `None`.
    pub async fn choose_focus(&self, space_id: &str, bot_id: &str, option_id: Option<&str>) -> Result<(), Error> {
        match option_id {
            Some(option_id) => {
                self.done("onboarding/choose", space_id, json!({ "botId": bot_id, "optionId": option_id })).await
            }
            None => self.done("onboarding/dismissFocus", space_id, json!({ "botId": bot_id })).await,
        }
    }

    /// Approved plugins. A query is matched by the server across the whole registry.
    pub async fn discover(&self, space_id: &str, query: Option<&str>) -> Result<Vec<PluginVersion>, Error> {
        let filter = query.map_or_else(|| json!({}), |query| json!({ "query": query }));
        self.pages("pluginRegistry/discover", space_id, filter).await
    }

    pub async fn my_plugins(&self, space_id: &str) -> Result<Vec<PluginVersion>, Error> {
        self.pages("pluginRegistry/mine", space_id, json!({})).await
    }

    pub async fn review_queue(&self, space_id: &str) -> Result<Vec<PluginVersion>, Error> {
        self.pages("pluginRegistry/submissions", space_id, json!({ "status": "pending" })).await
    }

    pub async fn installations(&self, space_id: &str) -> Result<Vec<Installation>, Error> {
        self.pages("pluginRegistry/installations", space_id, json!({})).await
    }

    pub async fn submit_plugin(
        &self,
        space_id: &str,
        slug: &str,
        version: i64,
        manifest: &Manifest,
    ) -> Result<PluginVersion, Error> {
        let input = json!({ "slug": slug, "version": version, "manifest": manifest });
        self.client.rpc("pluginRegistry/submit", Some(space_id), input).await
    }

    pub async fn review_plugin(
        &self,
        space_id: &str,
        version_id: &str,
        rejection: Option<&str>,
    ) -> Result<PluginVersion, Error> {
        let input = match rejection {
            Some(reason) => json!({ "versionId": version_id, "decision": "rejected", "reason": reason }),
            None => json!({ "versionId": version_id, "decision": "approved" }),
        };
        self.client.rpc("pluginRegistry/review", Some(space_id), input).await
    }

    pub async fn install_plugin(&self, space_id: &str, version_id: &str) -> Result<Installation, Error> {
        let input = json!({ "versionId": version_id });
        self.client.rpc("pluginRegistry/install", Some(space_id), input).await
    }

    /// Moves an installation to another approved version in one step. The server refuses with a
    /// conflict when the installation is no longer on `expected_version_id`, and clears the
    /// installation's per-agent grants when it switches.
    pub async fn switch_plugin_version(
        &self,
        space_id: &str,
        installation_id: &str,
        expected_version_id: &str,
        version_id: &str,
    ) -> Result<Installation, Error> {
        let input = json!({
            "installationId": installation_id,
            "expectedVersionId": expected_version_id,
            "versionId": version_id,
        });
        self.client.rpc("pluginRegistry/switchVersion", Some(space_id), input).await
    }

    pub async fn uninstall_plugin(&self, space_id: &str, installation_id: &str) -> Result<(), Error> {
        let input = json!({ "installationId": installation_id });
        self.done("pluginRegistry/uninstall", space_id, input).await
    }

    pub async fn set_grants(
        &self,
        space_id: &str,
        installation_id: &str,
        agent_id: &str,
        part_ids: &[String],
    ) -> Result<Installation, Error> {
        let input = json!({ "installationId": installation_id, "botId": agent_id, "partIds": part_ids });
        self.client.rpc("pluginRegistry/setGrants", Some(space_id), input).await
    }

    async fn done(&self, path: &str, space_id: &str, input: Value) -> Result<(), Error> {
        self.client.rpc::<Value>(path, Some(space_id), input).await.map(|_| ())
    }

    async fn pages<T: DeserializeOwned>(&self, path: &str, space_id: &str, filter: Value) -> Result<Vec<T>, Error> {
        const MOST_PAGES: usize = 10;
        let mut items = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MOST_PAGES {
            let mut input = filter.clone();
            input["limit"] = json!(50);
            if let Some(after) = &after {
                input["after"] = json!(after);
            }
            let page: Page<T> = self.client.rpc(path, Some(space_id), input).await?;
            items.extend(page.items);
            match page.next_after {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        Ok(items)
    }
}

/// The `threads/send` input for a message: only the parts it has. A message with files and no
/// words carries no text at all, which the server accepts.
fn send_input(target: &Target, message: &Outgoing<'_>) -> Value {
    let mut input = json!(target.wire());
    if let Some(text) = message.text.map(str::trim).filter(|text| !text.is_empty()) {
        input["text"] = json!(text);
    }
    if !message.artifact_ids.is_empty() {
        input["artifactIds"] = json!(message.artifact_ids);
    }
    if !message.mentions.is_empty() {
        let mentions: Vec<Value> = message.mentions.iter().map(|id| json!({ "kind": "bot", "id": id })).collect();
        input["mentions"] = json!(mentions);
    }
    input["clientNonce"] = json!(message.nonce);
    input
}

#[cfg(test)]
mod send_tests {
    use super::*;

    #[test]
    fn a_message_of_files_alone_carries_no_text() {
        let files = ["file-1".to_owned(), "file-2".to_owned()];
        let message = Outgoing { text: Some("  "), artifact_ids: &files, mentions: &[], nonce: "n1" };
        assert_eq!(
            send_input(&Target::Agent("bot".into()), &message),
            json!({ "botId": "bot", "artifactIds": ["file-1", "file-2"], "clientNonce": "n1" })
        );
    }

    #[test]
    fn a_group_message_names_the_bots_it_mentions() {
        let named = ["bot-2".to_owned()];
        let message = Outgoing { text: Some("@Support agent look"), artifact_ids: &[], mentions: &named, nonce: "n2" };
        assert_eq!(
            send_input(&Target::Group("group".into()), &message),
            json!({
                "groupId": "group",
                "text": "@Support agent look",
                "mentions": [{ "kind": "bot", "id": "bot-2" }],
                "clientNonce": "n2"
            })
        );
    }

    #[test]
    fn history_and_snapshots_read_their_cursor_members_and_times() {
        let snapshot: Snapshot = serde_json::from_value(json!({
            "cursor": 9, "olderCursor": 4, "run": null,
            "members": [{ "botId": "b1", "name": "Fixture agent", "color": "blue" }],
            "messages": [{ "id": "m", "seq": 5, "role": "user", "blocks": [], "createdAt": "2026-11-19T08:00:00.000Z" }]
        }))
        .unwrap();
        assert_eq!(snapshot.older_cursor, Some(4));
        assert_eq!(snapshot.members.unwrap()[0].bot_id, "b1");
        assert_eq!(snapshot.messages[0].created_at.as_deref(), Some("2026-11-19T08:00:00.000Z"));
        let last: MessagePage = serde_json::from_value(json!({ "messages": [], "olderCursor": null })).unwrap();
        assert_eq!(last.older_cursor, None);
    }
}

/// What to tell the person when a call fails: what happened, then what to do next.
pub fn explain(error: &Error) -> String {
    match error {
        #[cfg(target_os = "macos")]
        Error::CredentialStore(_) => {
            "Superbot couldn't access its saved session. Unlock the login keychain in Keychain Access, then try again."
                .into()
        }
        Error::Transport(_) | Error::Unavailable { .. } => SERVER_UNREACHABLE.into(),
        Error::Server { status: 401, .. } | Error::MissingSession | Error::InvalidSession => {
            "Your session ended. Sign in again.".into()
        }
        Error::Server { status: 403, .. } => "You don't have access to that here.".into(),
        Error::Server { status: 404, code, .. } if code.as_deref() != Some("NOT_FOUND") => {
            "This server doesn't offer that yet. Update the server and try again.".into()
        }
        Error::Server { message, .. } => message.clone(),
        other => other.to_string(),
    }
}
