pub mod conversation;
pub mod conversations;
pub mod create;
mod keyboard;
mod local_models;
pub mod new_agent;
pub mod onboarding;
pub mod reveal;

use std::future::Future;
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::*;
use serde_json::json;
use superbot_client::{remember_sign_in_server, Client, CredentialStore, Error, SignUpResult, SpaceNotification};

use crate::api::{self, AgentSummary, Api, CurrentSpace, GroupSummary, Me, Navigation, SpaceSummary, Target};
use crate::outbox::Drafts;
use crate::runtime::{follow_space, network, Live};
use crate::ui::agent_panel::{AgentInfo, AgentPanel, PanelPerformance};
use crate::ui::inbox::Inbox;
use crate::ui::message_search::MessageSearch;
use crate::ui::corner::Corner;
use crate::ui::motion::Tints;
use crate::ui::store::Store;
use crate::ui::workspace::Workspace;

pub use conversation::Chat;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Session {
    /// A saved session is being checked, or its check stopped with an error.
    Restoring,
    SignedOut,
    SignedIn,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum View {
    Chat,
    Store,
    Workspace,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SignInMode {
    Password,
    CreateAccount,
    /// A sign-in code is on its way to the address in the email field.
    Code,
    /// Pasting an invite link, which names the server and is used once signed in.
    Invite,
}

pub struct SignIn {
    pub mode: SignInMode,
    pub server: Entity<InputState>,
    pub name: Entity<InputState>,
    pub email: Entity<InputState>,
    pub password: Entity<InputState>,
    pub code: Entity<InputState>,
    pub invite: Entity<InputState>,
    pub busy: bool,
    pub error: Option<String>,
    /// What happened last, when it was not an error: a code was sent, an address needs verifying.
    pub status: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum MenuKind {
    Spaces,
    Profile,
    Agent(String),
    New,
    Model(String),
    Conversation { agent: String, thread: String },
}

pub struct Menu {
    pub kind: MenuKind,
    pub at: Point<Pixels>,
    return_focus: Option<WeakFocusHandle>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum DialogKind {
    NewSpace,
    JoinSpace,
    RenameAgent(String),
}

pub struct Dialog {
    pub kind: DialogKind,
    pub input: Entity<InputState>,
    pub busy: bool,
    pub error: Option<String>,
    _submit: Subscription,
}

#[derive(Clone)]
pub enum Undo {
    RestoreAgent(String),
}

pub struct Notice {
    pub text: String,
    pub error: bool,
    pub undo: Option<Undo>,
    serial: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SidebarRead {
    Current,
    Navigation,
}

#[derive(Default)]
struct Sidebar {
    stream: Option<Task<()>>,
    reading: Option<Task<()>>,
    pending: Option<SidebarRead>,
}

pub struct Desktop {
    pub session: Session,
    pub sign_in: SignIn,
    pub api: Option<Api>,
    pub me: Option<Me>,
    pub spaces: Vec<SpaceSummary>,
    pub space: Option<CurrentSpace>,
    space_selection: u64,
    sidebar: Sidebar,
    pub view: View,
    pub chat: Option<Chat>,
    /// What is typed and attached in conversations that are not on screen.
    pub drafts: Drafts,
    local_models: local_models::LocalModels,
    local_writes: std::collections::HashMap<crate::outbox::Place, conversation::LocalWrite>,
    pub composer: Entity<TextareaState>,
    pub search: Entity<InputState>,
    pub search_open: bool,
    pub message_search: MessageSearch,
    pub tints: Tints<Corner>,
    pub tile_preview: crate::ui::tile_preview::TilePreview,
    pub store: Store,
    pub workspace: Workspace,
    pub agent_panel: Option<AgentPanel>,
    pub panel_performance: PanelPerformance,
    pub inbox: Inbox,
    pub agent_info: AgentInfo,
    pub model_menu: crate::ui::model_menu::ModelMenu,
    pub conversations: conversations::Conversations,
    pub onboarding: onboarding::Onboarding,
    pub menu: Option<Menu>,
    pub dialog: Option<Dialog>,
    modal_focus: Option<keyboard::ModalFocus>,
    /// The Space selection a new agent is being made in.
    creating_agent: Option<u64>,
    pub create: create::Create,
    pub notice: Option<Notice>,
    notices: u64,
    _subscriptions: Vec<Subscription>,
}

impl Desktop {
    pub fn new(server: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut desktop = Self::initial(server, window, cx);
        desktop.restore(window, cx);
        desktop
    }

    fn initial(server: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = |placeholder: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
        };
        let server_field =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://superbot.example.com").default_value(server));
        let password = cx.new(|cx| InputState::new(window, cx).masked(true));
        let composer = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 8).submit_on_enter(true));
        let search = field("Search", window, cx);
        let sign_in = SignIn {
            mode: SignInMode::Password,
            server: server_field,
            name: field("Ada Lovelace", window, cx),
            email: field("you@example.com", window, cx),
            password,
            code: field("123456", window, cx),
            invite: field("Paste the link you were sent", window, cx),
            busy: false,
            error: None,
            status: None,
        };

        let mut subscriptions = vec![
            cx.subscribe_in(&composer, window, |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => this.send(window, cx),
                InputEvent::PressEnter { shift: true, .. }
                | InputEvent::Change
                | InputEvent::Focus
                | InputEvent::Blur => cx.notify(),
            }),
            cx.subscribe_in(&search, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.search_messages(window, cx);
                    cx.notify();
                }
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() {
                    gpui_kit::base::apply_system_reduce_motion(cx);
                    if this.session == Session::SignedIn {
                        this.reload_space(cx);
                    }
                }
            }),
        ];
        subscriptions.extend(keyboard::shortcuts(window, cx));
        for input in [&sign_in.email, &sign_in.password, &sign_in.code, &sign_in.name, &sign_in.server, &sign_in.invite] {
            subscriptions.push(cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.submit_sign_in(window, cx);
                }
            }));
        }

        Self {
            session: Session::Restoring,
            sign_in,
            api: None,
            me: None,
            spaces: Vec::new(),
            space: None,
            space_selection: 0,
            sidebar: Sidebar::default(),
            view: View::Chat,
            chat: None,
            drafts: Drafts::default(),
            local_models: Default::default(),
            local_writes: Default::default(),
            composer,
            search,
            search_open: false,
            message_search: MessageSearch::default(),
            tints: Tints::default(),
            tile_preview: Default::default(),
            store: Store::new(window, cx),
            workspace: Workspace::default(),
            agent_panel: None,
            panel_performance: PanelPerformance::default(),
            inbox: Inbox::default(),
            agent_info: AgentInfo::default(),
            model_menu: Default::default(),
            conversations: Default::default(),
            onboarding: Default::default(),
            menu: None,
            dialog: None,
            modal_focus: None,
            creating_agent: None,
            create: create::Create::default(),
            notice: None,
            notices: 0,
            _subscriptions: subscriptions,
        }
    }

    /// Runs one call against the server, then hands its answer back to the interface.
    pub fn call<T: Send + 'static>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        work: impl Future<Output = Result<T, Error>> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, Error>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let selection = self.space_selection;
        cx.spawn_in(window, async move |this, cx| {
            let result = network(work).await;
            this.update_in(cx, |this, window, cx| {
                let rejected = matches!(&result, Err(error) if error.is_unauthorized());
                if this.space_selection != selection {
                    return;
                }
                if rejected && this.session == Session::SignedIn {
                    this.session_ended(window, cx);
                } else {
                    done(this, result, window, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn space_id(&self) -> Option<String> {
        self.space.as_ref().map(|space| space.id.clone())
    }

    pub fn agents(&self) -> &[AgentSummary] {
        self.space.as_ref().map_or(&[], |space| &space.bots)
    }

    pub fn groups(&self) -> &[GroupSummary] {
        self.space.as_ref().map_or(&[], |space| &space.groups)
    }

    pub fn agent(&self, id: &str) -> Option<&AgentSummary> {
        self.agents().iter().find(|agent| agent.id == id)
    }

    /// The current conversation's web address. The web client signs in on its own.
    pub fn web_workspace_url(&self) -> Option<String> {
        let server = self.api.as_ref()?.client.server();
        Some(web_app_url(server, self.chat.as_ref().map(|chat| &chat.target)))
    }

    /// The web client in a window of this app, or in the browser where the platform has no web view.
    pub fn open_web_workspace(&mut self, cx: &mut Context<Self>) {
        if let Some(url) = self.web_workspace_url() {
            self.open_web_url(url, cx);
        }
    }

    /// A page of the server's web app, such as `/app/board`, in the workspace window.
    pub fn open_web_page(&mut self, path: &str, cx: &mut Context<Self>) {
        let Some(api) = self.api.as_ref() else { return };
        if path.starts_with('/') && !path.starts_with("//") {
            let url = format!("{}{path}", api.client.server().trim_end_matches('/'));
            self.open_web_url(url, cx);
        }
    }

    pub(crate) fn open_web_url(&mut self, url: String, cx: &mut Context<Self>) {
        let (Some(api), Some(me)) = (self.api.as_ref(), self.me.as_ref()) else { return };
        if !crate::web::open(api.client.server(), &me.user_id, &url, cx) {
            cx.open_url(&url);
        }
    }

    pub fn open_web_workspace_in_browser(&mut self, cx: &mut Context<Self>) {
        if let Some(url) = self.web_workspace_url() {
            cx.open_url(&url);
        }
    }

    /// The name on the open conversation, whichever kind it is.
    pub fn target_name(&self, target: &Target) -> String {
        match target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => self.agent(id).map(|agent| agent.name.clone()),
            Target::Group(id) => self.groups().iter().find(|group| &group.id == id).map(|group| group.name.clone()),
        }
        .unwrap_or_default()
    }

    fn server_client(&self, cx: &App) -> Result<Client, Error> {
        Client::new(self.sign_in.server.read(cx).value().trim())
    }

    fn restore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(client) = self.server_client(cx) else {
            self.session = Session::SignedOut;
            return;
        };
        let work = async move {
            CredentialStore::restore(&client, |client| async move {
                let api = Api::new(client);
                let (me, navigation) = tokio::try_join!(api.me(), api.initial_navigation())?;
                let navigation = onboarding::resumed(&api, &me, navigation).await?;
                Ok((api, me, navigation))
            })
            .await
        };
        self.call(window, cx, work, |this, result, window, cx| match result {
            Ok(Some((api, me, navigation))) => {
                this.enter(api, me, navigation, window, cx);
                this.signed_in(false, window, cx);
            }
            Ok(None) => this.session = Session::SignedOut,
            Err(error) => {
                if matches!(error, Error::InvalidSession) {
                    this.session = Session::SignedOut;
                }
                this.sign_in.error = Some(api::explain(&error));
            }
        });
    }

    pub fn set_sign_in_mode(&mut self, mode: SignInMode, cx: &mut Context<Self>) {
        self.sign_in.mode = mode;
        self.sign_in.error = None;
        self.sign_in.status = None;
        cx.notify();
    }

    pub fn submit_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sign_in.busy {
            return;
        }
        if self.sign_in.mode == SignInMode::Invite {
            self.continue_with_invite(window, cx);
            return;
        }
        let client = match self.server_client(cx) {
            Ok(client) => client,
            Err(error) => {
                self.sign_in.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        let read = |input: &Entity<InputState>| input.read(cx).value().trim().to_owned();
        let (name, email, code) = (read(&self.sign_in.name), read(&self.sign_in.email), read(&self.sign_in.code));
        let password = self.sign_in.password.read(cx).value().to_string();
        let missing = match self.sign_in.mode {
            _ if email.is_empty() => Some("Enter your email."),
            SignInMode::CreateAccount if name.is_empty() => Some("Enter your name."),
            SignInMode::Password | SignInMode::CreateAccount if password.is_empty() => Some("Enter your password."),
            SignInMode::Code if code.is_empty() => Some("Enter the code from your email."),
            SignInMode::Invite => None,
            _ => None,
        };
        if let Some(missing) = missing {
            self.sign_in.error = Some(missing.into());
            cx.notify();
            return;
        }
        if !self.save_server_choice(&client, cx) {
            return;
        }
        self.sign_in.busy = true;
        self.sign_in.error = None;
        self.sign_in.status = None;
        cx.notify();

        let mode = self.sign_in.mode;
        let work = async move {
            let client = match mode {
                SignInMode::Password | SignInMode::Invite => client.sign_in(&email, &password).await?,
                SignInMode::Code => client.sign_in_with_code(&email, &code).await?,
                SignInMode::CreateAccount => match client.sign_up(&name, &email, &password).await? {
                    SignUpResult::SignedIn(client) => client,
                    SignUpResult::VerifyEmail => return Ok(None),
                },
            };
            CredentialStore::save(&client).await?;
            let api = Api::new(client);
            let (me, navigation) = tokio::try_join!(api.me(), api.initial_navigation())?;
            let navigation = onboarding::resumed(&api, &me, navigation).await?;
            Ok(Some((api, me, navigation)))
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.sign_in.busy = false;
            match result {
                Ok(Some((api, me, navigation))) => {
                    this.sign_in.password.update(cx, |input, cx| input.set_value("", window, cx));
                    this.sign_in.code.update(cx, |input, cx| input.set_value("", window, cx));
                    this.enter(api, me, navigation, window, cx);
                    this.signed_in(mode == SignInMode::CreateAccount, window, cx);
                }
                Ok(None) => {
                    this.sign_in.mode = SignInMode::Password;
                    this.sign_in.status = Some("Check your email to verify your address, then sign in.".into());
                }
                Err(error) => this.sign_in.error = Some(sign_in_failure(&error)),
            }
        });
    }

    pub fn request_code(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let email = self.sign_in.email.read(cx).value().trim().to_owned();
        let client = match self.server_client(cx) {
            Ok(client) if !email.is_empty() => client,
            Ok(_) => {
                self.sign_in.error = Some("Enter your email first.".into());
                cx.notify();
                return;
            }
            Err(error) => {
                self.sign_in.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        if !self.save_server_choice(&client, cx) {
            return;
        }
        self.sign_in.busy = true;
        self.sign_in.error = None;
        cx.notify();
        let work = async move { client.request_sign_in_code(&email).await };
        self.call(window, cx, work, |this, result, _, _| {
            this.sign_in.busy = false;
            match result {
                Ok(()) => {
                    this.sign_in.mode = SignInMode::Code;
                    this.sign_in.status = Some("We sent a code to your email.".into());
                }
                Err(error) => this.sign_in.error = Some(sign_in_failure(&error)),
            }
        });
    }

    fn save_server_choice(&mut self, client: &Client, cx: &mut Context<Self>) -> bool {
        let launch_server = std::env::var("SUPERBOT_SERVER").ok();
        if let Err(error) = remember_sign_in_server(client, launch_server.as_deref()) {
            self.sign_in.error = Some(format!("Could not save the server address: {error}"));
            cx.notify();
            return false;
        }
        true
    }

    fn enter(&mut self, api: Api, me: Me, navigation: Navigation, window: &mut Window, cx: &mut Context<Self>) {
        self.api = Some(api);
        self.me = Some(me);
        self.session = Session::SignedIn;
        self.view = View::Chat;
        self.apply_navigation(navigation);
        self.follow_sidebar(window, cx);
        match self.first_conversation() {
            Some(target) => self.open(target, window, cx),
            None => self.chat = None,
        }
    }

    pub fn sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        let work = async move {
            let revoked = api.client.sign_out().await;
            CredentialStore::delete(&api.client).await?;
            match revoked {
                Err(error) if !error.is_unauthorized() => Err(error),
                _ => Ok(()),
            }
        };
        self.leave(window, cx);
        self.call(window, cx, work, |this, result, _, _| {
            if let Err(error) = result {
                this.sign_in.error = Some(api::explain(&error));
            }
        });
        cx.notify();
    }

    pub(crate) fn session_ended(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(api) = self.api.clone() {
            self.call(window, cx, async move { CredentialStore::delete(&api.client).await }, |_, _, _, _| {});
        }
        self.leave(window, cx);
        self.sign_in.error = Some("Your session ended. Sign in again.".into());
    }

    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let (Some(api), Some(me)) = (self.api.as_ref(), self.me.as_ref()) {
            crate::web::close(api.client.server(), &me.user_id, cx);
        }
        self.session = Session::SignedOut;
        self.api = None;
        self.me = None;
        self.spaces.clear();
        self.space = None;
        self.local_models = Default::default();
        self.space_selection += 1;
        self.sidebar = Sidebar::default();
        self.conversations = Default::default();
        self.chat = None;
        self.drafts.clear();
        self.local_writes.clear();
        self.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
        self.search.update(cx, |search, cx| search.set_value("", window, cx));
        self.search_open = false;
        self.forget_message_search();
        self.forget_onboarding();
        self.menu = None;
        self.dialog = None;
        self.notice = None;
        self.store.forget();
        self.workspace = Workspace::default();
        self.agent_panel = None;
        self.inbox = Inbox::default();
        self.agent_info = AgentInfo::default();
    }

    fn apply_navigation(&mut self, navigation: Navigation) {
        self.spaces = navigation.spaces;
        self.apply_current_space(navigation.current);
        self.remember_open_space();
    }

    fn apply_current_space(&mut self, space: CurrentSpace) {
        if self.space.as_ref().is_none_or(|current| current.id != space.id) {
            self.local_models = Default::default();
        }
        self.space = Some(space);
        self.read_roster_models();
        self.place_arrivals();
    }

    fn first_conversation(&self) -> Option<Target> {
        self.agents()
            .first()
            .map(|agent| Target::Agent(agent.id.clone()))
            .or_else(|| self.groups().first().map(|group| Target::Group(group.id.clone())))
    }

    fn conversation_exists(&self, target: &Target) -> bool {
        match target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => self.agent(id).is_some(),
            Target::Group(id) => self.groups().iter().any(|group| &group.id == id),
        }
    }

    fn follow_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        let mut live = follow_space(api.client, space_id.clone());
        self.sidebar.stream = Some(cx.spawn_in(window, async move |this, cx| {
            while let Some(update) = live.recv().await {
                let current = this.update_in(cx, |this, window, cx| {
                    if !this.active_space(selection, &space_id) {
                        return false;
                    }
                    match update {
                        Live::Event(SpaceNotification::Roster | SpaceNotification::Organizations) => {
                            this.reload_space(cx);
                        }
                        Live::Event(SpaceNotification::Runs) => {
                            this.refresh_sidebar(SidebarRead::Current, cx);
                        }
                        Live::Event(SpaceNotification::PluginRegistry) => {
                            this.plugins_changed(window, cx);
                            this.app_grants_changed(window, cx);
                        }
                        Live::Unauthorized => {
                            this.session_ended(window, cx);
                            cx.notify();
                            return false;
                        }
                        _ => {}
                    }
                    true
                });
                if !matches!(current, Ok(true)) {
                    break;
                }
            }
        }));
    }

    fn active_space(&self, selection: u64, space_id: &str) -> bool {
        self.session == Session::SignedIn
            && self.space_selection == selection
            && self.space.as_ref().is_some_and(|space| space.id == space_id)
    }

    pub fn reload_space(&mut self, cx: &mut Context<Self>) {
        self.agent_info.stale();
        self.inbox.stale();
        self.refresh_sidebar(SidebarRead::Navigation, cx);
    }

    fn refresh_sidebar(&mut self, kind: SidebarRead, cx: &mut Context<Self>) {
        if self.sidebar.stream.is_none() {
            return;
        }
        if self.sidebar.reading.is_some() {
            self.sidebar.pending = self.sidebar.pending.max(Some(kind));
            return;
        }
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        self.sidebar.reading = Some(cx.spawn(async move |this, cx| {
            let space = space_id.clone();
            let result = network(async move {
                match kind {
                    SidebarRead::Current => api.space_navigation(Some(&space)).await,
                    SidebarRead::Navigation => api.navigation(Some(&space)).await,
                }
            })
            .await;
            this.update(cx, |this, cx| {
                if !this.active_space(selection, &space_id) {
                    return;
                }
                this.sidebar.reading = None;
                if let Some(navigation) = result.ok().filter(|nav| nav.current.id == space_id) {
                    match kind {
                        SidebarRead::Current => {
                            this.apply_current_space(navigation.current);
                        }
                        SidebarRead::Navigation => this.apply_navigation(navigation),
                    };
                    cx.notify();
                }
                if let Some(pending) = this.sidebar.pending.take() {
                    this.refresh_sidebar(pending, cx);
                }
            })
            .ok();
        }));
    }

    /// What arrives in the conversation on screen has been seen, so it is marked read before the
    /// sidebar is read again.
    fn read_open_conversation(&mut self, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(target) = self.chat.as_ref().map(|chat| chat.target.clone()) else { return };
        let selection = self.space_selection;
        cx.spawn(async move |this, cx| {
            let space = space_id.clone();
            network(async move { api.mark_read(&space, &target).await }).await.ok();
            this.update(cx, |this, cx| {
                if this.active_space(selection, &space_id) {
                    this.refresh_sidebar(SidebarRead::Current, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn switch_space(&mut self, space_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        self.space_selection += 1;
        self.sidebar = Sidebar::default();
        self.conversations = Default::default();
        let selection = self.space_selection;
        self.menu = None;
        self.dialog = None;
        self.keep_draft(window, cx);
        self.chat = None;
        self.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
        self.notice = None;
        self.store.forget();
        self.workspace = Workspace::default();
        self.agent_panel = None;
        self.inbox = Inbox::default();
        self.agent_info = AgentInfo::default();
        let work = async move { api.navigation(Some(&space_id)).await };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            _ if this.space_selection != selection => {}
            Ok(navigation) => {
                this.space_selection += 1;
                this.apply_navigation(navigation);
                this.follow_sidebar(window, cx);
                if let Some(target) = this.first_conversation() {
                    this.open(target, window, cx);
                }
                match this.view {
                    View::Store => this.load_store(window, cx),
                    View::Workspace => this.load_workspace(window, cx),
                    View::Chat => {}
                }
            }
            Err(error) => {
                this.follow_sidebar(window, cx);
                this.notify(api::explain(&error), true, None, cx);
            }
        });
        cx.notify();
    }

    pub fn show(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        self.view = view;
        if view != View::Chat {
            self.close_screen(cx);
        }
        self.set_workspace_visible(view == View::Workspace, window, cx);
        self.menu = None;
        match view {
            View::Store => self.load_store(window, cx),
            View::Workspace => self.load_workspace(window, cx),
            View::Chat => self.composer.update(cx, |composer, cx| composer.focus(window, cx)),
        }
        cx.notify();
    }

    pub fn open_menu(&mut self, kind: MenuKind, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.as_ref().is_some_and(|menu| menu.kind == kind) {
            self.close_menu(window, cx);
        } else {
            let return_focus = window.focused(cx).map(|focus| focus.downgrade());
            self.menu = Some(Menu { kind, at, return_focus });
        }
        cx.notify();
    }

    pub fn open_dialog(&mut self, kind: DialogKind, window: &mut Window, cx: &mut Context<Self>) {
        let (placeholder, value) = match &kind {
            DialogKind::NewSpace => ("Marketing", String::new()),
            DialogKind::JoinSpace => ("Paste the link you were sent", self.copied_invite(cx).unwrap_or_default()),
            DialogKind::RenameAgent(id) => ("Name", self.agent(id).map(|agent| agent.name.clone()).unwrap_or_default()),
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value));
        let submit = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.submit_dialog(window, cx);
            }
        });
        self.begin_modal(window, cx);
        input.update(cx, |input, cx| input.focus(window, cx));
        self.menu = None;
        self.dialog = Some(Dialog { kind, input, busy: false, error: None, _submit: submit });
        cx.notify();
    }

    pub fn submit_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dialog.as_ref().is_some_and(|dialog| dialog.kind == DialogKind::JoinSpace) {
            self.submit_invite_dialog(window, cx);
            return;
        }
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        let Some(dialog) = self.dialog.as_mut().filter(|dialog| !dialog.busy) else { return };
        let name = dialog.input.read(cx).value().trim().to_owned();
        if name.is_empty() {
            dialog.error = Some("Enter a name.".into());
            cx.notify();
            return;
        }
        dialog.busy = true;
        dialog.error = None;
        let kind = dialog.kind.clone();
        let created = kind == DialogKind::NewSpace;
        let work = async move {
            match kind {
                DialogKind::RenameAgent(id) => {
                    api.update_agent(&space_id, &id, json!({ "name": name })).await?;
                    Ok((None, api.navigation(Some(&space_id)).await?))
                }
                DialogKind::NewSpace => {
                    let space = api.create_space(&name).await?;
                    Ok((None, api.navigation(Some(&space.id)).await?))
                }
                DialogKind::JoinSpace => unreachable!("joining is submitted before naming"),
            }
        };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            _ if this.space_selection != selection => {}
            Ok((target, navigation)) => {
                let moved = this.space_id().as_deref() != Some(&navigation.current.id);
                this.dialog = None;
                this.apply_navigation(navigation);
                if moved {
                    this.space_selection += 1;
                    this.sidebar = Sidebar::default();
                    this.chat = None;
                    this.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
                    this.store.forget();
                    this.workspace = Workspace::default();
                    this.follow_sidebar(window, cx);
                }
                if let Some(target) = target.or_else(|| moved.then(|| this.first_conversation()).flatten()) {
                    this.open(target, window, cx);
                }
                if created {
                    this.open_new_space(window, cx);
                }
            }
            Err(error) => {
                if let Some(dialog) = this.dialog.as_mut() {
                    dialog.busy = false;
                    dialog.error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }

    pub fn set_pinned(&mut self, agent_id: String, pinned: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        self.menu = None;
        let work = async move {
            api.update_agent(&space_id, &agent_id, json!({ "pinned": pinned })).await?;
            api.navigation(Some(&space_id)).await
        };
        self.call(window, cx, work, move |this, result, _, cx| match result {
            _ if this.space_selection != selection => {}
            Ok(navigation) => this.apply_navigation(navigation),
            Err(error) => this.notify(api::explain(&error), true, None, cx),
        });
        cx.notify();
    }

    pub fn archive_agent(&mut self, agent_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        let name = self.agent(&agent_id).map(|agent| agent.name.clone()).unwrap_or_default();
        self.menu = None;
        let archived = agent_id.clone();
        let work = async move {
            api.archive_agent(&space_id, &agent_id).await?;
            api.navigation(Some(&space_id)).await
        };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            _ if this.space_selection != selection => {}
            Ok(navigation) => {
                this.apply_navigation(navigation);
                if this.chat.as_ref().is_some_and(|chat| !this.conversation_exists(&chat.target)) {
                    this.chat = None;
                    if let Some(target) = this.first_conversation() {
                        this.open(target, window, cx);
                    }
                }
                this.notify(format!("{name} archived"), false, Some(Undo::RestoreAgent(archived)), cx);
            }
            Err(error) => this.notify(api::explain(&error), true, None, cx),
        });
        cx.notify();
    }

    pub fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        let Some(Undo::RestoreAgent(agent_id)) = self.notice.take().and_then(|notice| notice.undo) else { return };
        let work = async move {
            api.restore_agent(&space_id, &agent_id).await?;
            api.navigation(Some(&space_id)).await
        };
        self.call(window, cx, work, move |this, result, _, cx| match result {
            _ if this.space_selection != selection => {}
            Ok(navigation) => this.apply_navigation(navigation),
            Err(error) => this.notify(api::explain(&error), true, None, cx),
        });
        cx.notify();
    }

    pub fn notify(&mut self, text: impl Into<String>, error: bool, undo: Option<Undo>, cx: &mut Context<Self>) {
        self.notices += 1;
        let serial = self.notices;
        self.notice = Some(Notice { text: text.into(), error, undo, serial });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(6)).await;
            this.update(cx, |this, cx| {
                if this.notice.as_ref().is_some_and(|notice| notice.serial == serial) {
                    this.notice = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

fn web_app_url(server: &str, open: Option<&Target>) -> String {
    let conversation = match open {
        Some(Target::Agent(id)) => format!("/{id}"),
        Some(Target::Conversation { agent, thread }) => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("threadId", thread)
                .finish();
            format!("/{agent}?{query}")
        }
        Some(Target::Group(id)) => format!("/g/{id}"),
        None => String::new(),
    };
    format!("{}/app{conversation}", server.trim_end_matches('/'))
}

fn sign_in_failure(error: &Error) -> String {
    match error {
        Error::Server { status: 401 | 403, code, .. } if code.as_deref() != Some("INVALID_ORIGIN") => {
            "That email and password don't match an account. Check them and try again.".into()
        }
        Error::Server { status: 404, .. } => "This server doesn't offer that way to sign in.".into(),
        other => api::explain(other),
    }
}

#[cfg(test)]
mod tests {
    use super::{web_app_url, Target};

    #[test]
    fn the_web_workspace_opens_on_the_conversation_on_screen() {
        let server = "https://superbot.example.com/";
        assert_eq!(web_app_url(server, None), "https://superbot.example.com/app");
        assert_eq!(web_app_url(server, Some(&Target::Agent("b1".into()))), "https://superbot.example.com/app/b1");
        assert_eq!(web_app_url(server, Some(&Target::Group("g1".into()))), "https://superbot.example.com/app/g/g1");
        assert_eq!(
            web_app_url(server, Some(&Target::Conversation { agent: "b1".into(), thread: "t1&2".into() })),
            "https://superbot.example.com/app/b1?threadId=t1%262"
        );
    }
}
