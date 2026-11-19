use std::future::Future;
use std::time::Duration;

use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::prelude::*;
use gpui_kit::{
    canvas, div, px, App, Div, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    KeyDownEvent, Pixels, SharedString, Window,
};
use superbot_client::{Client, Error};
use superbot_features::{Bot, Group};

use crate::icons::Glyph;
use crate::remote::{self, Failure, Remote};
use crate::sections::{
    activity::ActivityView, approvals::ApprovalsView, bots::BotsView, files::FilesView,
    groups::GroupsView, models::ModelsView, people::PeopleView, routines::RoutinesView,
};
use crate::theme::{tokens, Tokens, RADIUS_FULL};
use crate::ui::{self, Action, Tone};

/// The parts of a space the panel manages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Section {
    /// Bots and each bot's settings.
    #[default]
    Bots,
    /// Model connections, the main model and each agent's model.
    Models,
    /// Shared group conversations and the bots in them.
    Groups,
    /// Members, invites by email or link, and joining with a link.
    People,
    /// Files in the space: upload, download, versions, removal.
    Files,
    /// Scheduled work per bot, with its run history.
    Routines,
    /// What bots must ask before doing, and what is waiting on an answer.
    Approvals,
    /// Runs in progress and recently finished.
    Activity,
}

impl Section {
    pub const ALL: [Section; 8] = [
        Section::Bots,
        Section::Models,
        Section::Groups,
        Section::People,
        Section::Files,
        Section::Routines,
        Section::Approvals,
        Section::Activity,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Section::Bots => "Bots",
            Section::Models => "Models",
            Section::Groups => "Groups",
            Section::People => "People",
            Section::Files => "Files",
            Section::Routines => "Routines",
            Section::Approvals => "Approvals",
            Section::Activity => "Activity",
        }
    }

    fn glyph(self) -> Glyph {
        match self {
            Section::Bots => Glyph::Bot,
            Section::Models => Glyph::Cpu,
            Section::Groups => Glyph::UsersRound,
            Section::People => Glyph::Users,
            Section::Files => Glyph::Files,
            Section::Routines => Glyph::CalendarClock,
            Section::Approvals => Glyph::ShieldCheck,
            Section::Activity => Glyph::Activity,
        }
    }
}

/// What the host may want to react to. Subscribe with `cx.subscribe(&panel, …)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelEvent {
    /// The person asked to see this bot's conversation.
    OpenBot { bot_id: String },
    /// The person asked to see this group's conversation.
    OpenGroup { group_id: String },
    /// Bots were created, renamed, archived or restored; refresh the bot list.
    BotsChanged,
    /// Groups were created, changed, archived, restored or removed.
    GroupsChanged,
    /// The person left the space; `active_space_id` is the space the server
    /// moved them to. The panel shows nothing more for the space it was bound to.
    SpaceLeft { active_space_id: String },
    /// The person joined another space with an invite link.
    SpaceJoined { space_id: String },
    /// The server rejected the session; return to sign in.
    SessionExpired,
}

/// A value read from the server, kept while it is being re-read.
pub(crate) struct Loaded<T> {
    pub(crate) value: Option<T>,
    pub(crate) loading: bool,
    pub(crate) failure: Option<Failure>,
}

impl<T> Default for Loaded<T> {
    fn default() -> Self {
        Self {
            value: None,
            loading: false,
            failure: None,
        }
    }
}

impl<T> Loaded<T> {
    pub(crate) fn begin(&mut self) {
        self.loading = true;
        self.failure = None;
    }

    pub(crate) fn finish(&mut self, result: Result<T, Failure>) {
        self.loading = false;
        match result {
            Ok(value) => {
                self.value = Some(value);
                self.failure = None;
            }
            Err(failure) => self.failure = Some(failure),
        }
    }

    /// True before the first read has been asked for.
    pub(crate) fn untouched(&self) -> bool {
        self.value.is_none() && !self.loading && self.failure.is_none()
    }
}

/// Something a toast can take back.
#[derive(Clone)]
pub(crate) enum Undo {
    RestoreBot(String),
    RestoreGroup(String),
}

struct Toast {
    id: u64,
    message: SharedString,
    undo: Option<Undo>,
}

/// Whether this account can still use the space the panel is bound to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Open,
    /// A call was refused as unauthorized; the session is being re-checked.
    Checking,
    Left,
    Lost,
    SignedOut,
}

const COMPACT_BELOW: Pixels = px(720.);
const TOAST_LIFETIME: Duration = Duration::from_secs(6);

/// The workspace management view. Create it with [`crate::open`] or
/// [`WorkspacePanel::build`].
pub struct WorkspacePanel {
    pub(crate) remote: Remote,
    epoch: u64,
    section: Section,
    focus: FocusHandle,
    compact: bool,
    toast: Option<Toast>,
    toasts_shown: u64,
    pub(crate) access: Access,
    pub(crate) space_name: Option<SharedString>,
    pub(crate) bots: Loaded<Vec<Bot>>,
    pub(crate) groups: Loaded<Vec<Group>>,
    pub(crate) bots_view: BotsView,
    pub(crate) groups_view: GroupsView,
    pub(crate) people: PeopleView,
    pub(crate) files: FilesView,
    pub(crate) routines: RoutinesView,
    pub(crate) approvals: ApprovalsView,
    pub(crate) activity: ActivityView,
    pub(crate) models: ModelsView,
}

impl EventEmitter<PanelEvent> for WorkspacePanel {}

impl Focusable for WorkspacePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl WorkspacePanel {
    /// Builds the panel as a view the host places in its own window, such as
    /// a page or the side panel. It lays itself out for the width it is
    /// given: a section list beside the content from 720px, pills above it
    /// below that.
    ///
    /// `client` is a clone of the host's signed-in client; `initial` chooses
    /// the first section, `None` shows bots.
    pub fn build(
        client: Client,
        space_id: impl Into<SharedString>,
        initial: Option<Section>,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let space_id = space_id.into();
        cx.new(|cx| {
            let mut panel = Self {
                remote: Remote::new(client, &space_id),
                epoch: 0,
                section: initial.unwrap_or_default(),
                focus: cx.focus_handle(),
                compact: false,
                toast: None,
                toasts_shown: 0,
                access: Access::Open,
                space_name: None,
                bots: Loaded::default(),
                groups: Loaded::default(),
                bots_view: BotsView::new(window, cx),
                groups_view: GroupsView::new(window, cx),
                people: PeopleView::new(window, cx),
                files: FilesView::new(),
                routines: RoutinesView::new(window, cx),
                approvals: ApprovalsView::new(window, cx),
                activity: ActivityView::new(),
                models: ModelsView::new(window, cx),
            };
            cx.observe_window_activation(window, |panel: &mut Self, window, cx| {
                if window.is_window_active() {
                    panel.refresh(window, cx);
                }
            })
            .detach();
            panel.enter_section(window, cx);
            panel
        })
    }

    /// The section on screen.
    pub fn section(&self) -> Section {
        self.section
    }

    /// The space this panel manages.
    pub fn space_id(&self) -> &str {
        self.remote.space_id()
    }

    /// Switches to `section`, leaving any open editor in the old one.
    pub fn show(&mut self, section: Section, window: &mut Window, cx: &mut Context<Self>) {
        if self.section != section {
            self.section = section;
            self.leave_details();
        }
        self.enter_section(window, cx);
        cx.notify();
    }

    /// Binds the panel to another space of the same session and reads it
    /// afresh. Answers still on their way for the old space are dropped.
    pub fn set_space(
        &mut self,
        space_id: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let space_id = space_id.into();
        let client = self.remote.client().clone();
        self.remote = Remote::new(client, &space_id);
        self.epoch += 1;
        self.access = Access::Open;
        self.space_name = None;
        self.toast = None;
        self.bots = Loaded::default();
        self.groups = Loaded::default();
        self.bots_view.reset();
        self.groups_view.reset();
        self.people.reset();
        self.files.reset();
        self.routines.reset();
        self.approvals.reset();
        self.activity.reset();
        self.models.reset();
        self.enter_section(window, cx);
        cx.notify();
    }

    /// Re-reads what the current section shows. The host calls this when its
    /// live stream signals a change in the space; the panel also does it when
    /// its window becomes active.
    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.access != Access::Open {
            return;
        }
        self.load_bots(window, cx);
        match self.section {
            Section::Bots => self.refresh_bots(window, cx),
            Section::Models => self.load_models(window, cx),
            Section::Groups => self.load_groups(window, cx),
            Section::People => self.load_members(window, cx),
            Section::Files => self.load_files(window, cx),
            Section::Routines => {
                self.load_groups(window, cx);
                self.load_routines(window, cx);
            }
            Section::Approvals => self.load_approvals(window, cx),
            Section::Activity => self.load_activity(window, cx),
        }
    }

    fn enter_section(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bots.untouched() {
            self.load_bots(window, cx);
        }
        if self.space_name.is_none() && self.section != Section::People {
            self.load_members(window, cx);
        }
        match self.section {
            Section::Bots => {}
            Section::Models => self.load_models(window, cx),
            Section::Groups => self.load_groups(window, cx),
            Section::People => self.load_members(window, cx),
            Section::Files => {
                self.load_groups(window, cx);
                self.load_files(window, cx);
            }
            Section::Routines => self.load_routines(window, cx),
            Section::Approvals => self.load_approvals(window, cx),
            Section::Activity => self.load_activity(window, cx),
        }
    }

    fn leave_details(&mut self) {
        self.bots_view.close();
        self.groups_view.close();
        self.routines.close();
        self.models.close();
    }

    /// Runs `work` off the GUI thread and hands its outcome to `done` on it.
    /// The outcome is dropped if the panel has moved to another space.
    pub(crate) fn request<T: Send + 'static>(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
        work: impl Future<Output = Result<T, Error>> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, Failure>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let epoch = self.epoch;
        let outcome = remote::request(work);
        cx.spawn_in(window, async move |panel, cx| {
            let outcome = outcome.await;
            panel
                .update_in(cx, |panel, window, cx| {
                    if panel.epoch != epoch {
                        return;
                    }
                    let outcome = outcome.map_err(|error| Failure::from_error(&error));
                    if matches!(outcome, Err(Failure::Unauthorized)) {
                        panel.check_access(window, cx);
                    }
                    done(panel, outcome, window, cx);
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    // The server answers HTTP 401 both for a dead session and for a Space the
    // account is not in, so a space-less read tells the two apart.
    fn check_access(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.access != Access::Open {
            return;
        }
        self.access = Access::Checking;
        let epoch = self.epoch;
        let client = self.remote.client().clone();
        let space_id = self.remote.space_id().to_owned();
        let spaces = remote::request(async move { client.list_spaces().await });
        cx.spawn_in(window, async move |panel, cx| {
            let spaces = spaces.await;
            panel
                .update_in(cx, |panel, _, cx| {
                    if panel.epoch != epoch || panel.access != Access::Checking {
                        return;
                    }
                    panel.access = match spaces {
                        Ok(spaces) if spaces.iter().any(|space| space.id == space_id) => {
                            Access::Open
                        }
                        Ok(spaces) => {
                            if let Some(next) = spaces.first() {
                                cx.emit(PanelEvent::SpaceLeft {
                                    active_space_id: next.id.clone(),
                                });
                            }
                            Access::Lost
                        }
                        Err(error) if error.is_unauthorized() => {
                            cx.emit(PanelEvent::SessionExpired);
                            Access::SignedOut
                        }
                        Err(_) => Access::Open,
                    };
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    pub(crate) fn load_bots(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bots.loading {
            return;
        }
        self.bots.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_bots().await },
            |panel, bots, window, cx| {
                panel.bots.finish(bots);
                panel.bots_arrived(window, cx);
            },
        );
    }

    pub(crate) fn load_groups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.groups.loading {
            return;
        }
        self.groups.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_groups().await },
            |panel, groups, _, _| panel.groups.finish(groups),
        );
    }

    pub(crate) fn bot_name(&self, bot_id: &str) -> Option<SharedString> {
        self.bots
            .value
            .as_ref()?
            .iter()
            .find(|bot| bot.id == bot_id)
            .map(|bot| SharedString::from(bot.name.clone()))
    }

    pub(crate) fn group_name(&self, group_id: &str) -> Option<SharedString> {
        self.groups
            .value
            .as_ref()?
            .iter()
            .find(|group| group.id == group_id)
            .map(|group| SharedString::from(group.name.clone()))
    }

    /// Shows a toast for six seconds, with **Undo** when the change is reversible.
    pub(crate) fn toast(
        &mut self,
        message: impl Into<SharedString>,
        undo: Option<Undo>,
        cx: &mut Context<Self>,
    ) {
        self.toasts_shown += 1;
        let id = self.toasts_shown;
        self.toast = Some(Toast {
            id,
            message: message.into(),
            undo,
        });
        cx.spawn(async move |panel, cx| {
            cx.background_executor().timer(TOAST_LIFETIME).await;
            panel
                .update(cx, |panel, cx| {
                    if panel.toast.as_ref().is_some_and(|toast| toast.id == id) {
                        panel.toast = None;
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(undo) = self.toast.take().and_then(|toast| toast.undo) else {
            return;
        };
        match undo {
            Undo::RestoreBot(bot_id) => self.restore_bot(bot_id, window, cx),
            Undo::RestoreGroup(group_id) => self.restore_group(group_id, window, cx),
        }
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && !event.keystroke.modifiers.modified() {
            self.leave_details();
            cx.notify();
        }
    }

    fn render_nav(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let rows = Section::ALL.into_iter().map(|section| {
            ui::nav_row(
                ("section", section as usize),
                section.glyph(),
                section.label(),
                section == self.section,
                t,
            )
            .on_click(cx.listener(move |panel, _, window, cx| panel.show(section, window, cx)))
        });
        if self.compact {
            return div()
                .flex()
                .flex_shrink_0()
                .gap_1()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(t.edge)
                .bg(t.panel)
                .child(
                    div()
                        .id("sections")
                        .flex()
                        .gap_1()
                        .overflow_x_scroll()
                        .children(rows),
                );
        }
        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .gap_0p5()
            .w(px(200.))
            .h_full()
            .p_3()
            .border_r_1()
            .border_color(t.edge)
            .bg(t.panel)
            .child(
                div()
                    .h(px(26.))
                    .flex_shrink_0()
                    .px_2()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(t.ink)
                    .truncate()
                    .children(self.space_name.clone()),
            )
            .children(rows)
    }

    fn render_toast(&self, t: &Tokens, cx: &mut Context<Self>) -> Option<Div> {
        let toast = self.toast.as_ref()?;
        Some(
            div()
                .absolute()
                .bottom_4()
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .id("toast")
                        .occlude()
                        .flex()
                        .items_center()
                        .gap_2()
                        .max_w(px(480.))
                        .min_h(px(40.))
                        .pl_4()
                        .pr_2()
                        .py_1()
                        .rounded(RADIUS_FULL)
                        .bg(t.menu)
                        .border_1()
                        .border_color(t.hairline)
                        .shadow_lg()
                        .child(ui::body(toast.message.clone(), t.ink))
                        .when(toast.undo.is_some(), |this| {
                            this.child(
                                Action::new("toast-undo", "Undo")
                                    .tone(Tone::Link)
                                    .small()
                                    .on_click(
                                        cx.listener(|panel, _, window, cx| panel.undo(window, cx)),
                                    ),
                            )
                        })
                        .child(
                            Action::icon("toast-dismiss", Glyph::X, "Dismiss")
                                .small()
                                .on_click(cx.listener(|panel, _, _, cx| {
                                    panel.toast = None;
                                    cx.notify();
                                })),
                        ),
                ),
        )
    }

    fn render_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        match self.section {
            Section::Bots => self.render_bots(window, cx),
            Section::Models => self.render_models(window, cx),
            Section::Groups => self.render_groups(window, cx),
            Section::People => self.render_people(window, cx),
            Section::Files => self.render_files(window, cx),
            Section::Routines => self.render_routines(window, cx),
            Section::Approvals => self.render_approvals(window, cx),
            Section::Activity => self.render_activity(window, cx),
        }
    }
}

impl Render for WorkspacePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let panel = cx.entity().downgrade();
        let compact = self.compact;
        let measure = canvas(
            move |bounds, window, cx| {
                let now_compact = bounds.size.width < COMPACT_BELOW;
                if now_compact != compact {
                    window.defer(cx, move |_, cx| {
                        panel
                            .update(cx, |panel, cx| {
                                panel.compact = now_compact;
                                cx.notify();
                            })
                            .ok();
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let content = match self.access {
            Access::Open => self.render_section(window, cx),
            Access::Checking => ui::loading_line(&t),
            Access::Left => ui::notice("You left this space.", None, &t),
            Access::Lost => ui::notice("You no longer have access to this space.", None, &t),
            Access::SignedOut => ui::notice("Your session ended. Sign in again.", None, &t),
        };
        let pad = if compact { px(16.) } else { px(32.) };

        div()
            .id("workspace-panel")
            .key_context("WorkspacePanel")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .relative()
            .size_full()
            .flex()
            .when(compact, |this| this.flex_col())
            .bg(t.app)
            .text_color(t.ink)
            .text_size(px(13.))
            .line_height(px(18.))
            .child(measure)
            .child(self.render_nav(&t, cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .child(
                        div()
                            .id(("section-scroll", self.section as usize))
                            .size_full()
                            .overflow_y_scrollbar()
                            .child(
                                div()
                                    .w_full()
                                    .max_w(px(820.))
                                    .px(pad)
                                    .pt(if compact { px(20.) } else { px(56.) })
                                    .pb(px(72.))
                                    .child(content),
                            ),
                    )
                    .children(self.render_toast(&t, cx)),
            )
    }
}

/// The header of a section: its title, with the view's one primary action and
/// any quiet icon buttons at the end.
pub(crate) fn section_header(
    title: impl Into<SharedString>,
    trailing: impl IntoIterator<Item = Action>,
    t: &Tokens,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .pb_4()
        .child(div().flex_1().min_w_0().child(ui::section_title(title, t)))
        .children(trailing)
}

/// The header of a detail view: a back chevron before the title.
pub(crate) fn detail_header(
    title: impl Into<SharedString>,
    back: Action,
    trailing: impl IntoIterator<Item = Action>,
    t: &Tokens,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .pb_4()
        .child(back)
        .child(div().flex_1().min_w_0().child(ui::section_title(title, t)))
        .children(trailing)
}

/// What stands in for a list that has nothing to show yet: a loading line or
/// the failure with **Try again**. `None` once there is a value to render.
pub(crate) fn placeholder<T>(
    loaded: &Loaded<T>,
    action: &str,
    retry: Action,
    t: &Tokens,
) -> Option<Div> {
    if loaded.value.is_some() {
        return None;
    }
    Some(match &loaded.failure {
        Some(failure) => ui::notice(
            failure.sentence(action),
            (*failure != Failure::Denied && *failure != Failure::Unauthorized)
                .then(|| retry.tone(Tone::Link).small()),
            t,
        ),
        None => ui::loading_line(t),
    })
}
