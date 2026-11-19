mod edit;
mod live;
mod render;

use gpui_kit::component::input::{InputState, TextareaState};
use gpui_kit::prelude::*;
use gpui_kit::{App, Entity, SharedString, Task, Window};
use superbot_features::{
    CreateTicket, Labs, Patch, Ticket, TicketComment, TicketStatus, TicketUpdate,
};
use tokio::sync::mpsc::unbounded_channel;

use self::edit::{rebase, Changes, Fields};
use self::live::Live;
use crate::panel::{Loaded, PanelEvent, WorkspacePanel};
use crate::remote::{self, Failure};
use crate::ui;

/// The web page for what only the web board does, such as rendering Markdown.
pub(crate) const WEB_BOARD: &str = "/app/board";

#[derive(Clone, PartialEq, Eq)]
enum Mode {
    List,
    Create,
    Edit(String),
}

/// Whether the board answers for this account. It is a Labs feature upstream.
#[derive(Clone, PartialEq, Eq)]
enum Gate {
    Open,
    /// `tickets/list` answered "not found": Board is off for this account.
    Off {
        labs: Option<Labs>,
    },
}

pub(crate) struct BoardView {
    tickets: Loaded<Vec<Ticket>>,
    /// A change arrived while the board was being read; read it once more after.
    read_again: bool,
    gate: Gate,
    switching_lab: bool,
    mode: Mode,
    title: Entity<InputState>,
    description: Entity<TextareaState>,
    owner: Option<String>,
    priority: superbot_features::TicketPriority,
    /// The server's copy the form was last brought up to date with.
    base: Option<Ticket>,
    /// Someone else changed the open ticket; true when it touched a field being edited.
    changed_elsewhere: Option<bool>,
    saving: bool,
    moving: Option<TicketStatus>,
    problem: Option<SharedString>,
    comments: Loaded<Vec<TicketComment>>,
    comment: Entity<TextareaState>,
    commenting: bool,
    live: Option<Task<()>>,
}

impl BoardView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            tickets: Loaded::default(),
            read_again: false,
            gate: Gate::Open,
            switching_lab: false,
            mode: Mode::List,
            title: ui::new_input("What needs doing", window, cx),
            description: ui::new_textarea(
                "Details, links and what done looks like",
                (4, 14),
                window,
                cx,
            ),
            owner: None,
            priority: Default::default(),
            base: None,
            changed_elsewhere: None,
            saving: false,
            moving: None,
            problem: None,
            comments: Loaded::default(),
            comment: ui::new_textarea("Add a comment", (2, 8), window, cx),
            commenting: false,
            live: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.close();
        self.stop_live();
        self.tickets = Loaded::default();
        self.read_again = false;
        self.gate = Gate::Open;
    }

    pub(crate) fn close(&mut self) {
        self.mode = Mode::List;
        self.base = None;
        self.changed_elsewhere = None;
        self.saving = false;
        self.moving = None;
        self.problem = None;
        self.comments = Loaded::default();
        self.commenting = false;
    }

    /// Stops following the board. Dropping the receiver ends the stream on the network side.
    pub(crate) fn stop_live(&mut self) {
        self.live = None;
    }

    fn fields(&self, cx: &App) -> Fields {
        Fields {
            title: self.title.read(cx).value().to_string(),
            description: self.description.read(cx).value().to_string(),
            owner: self.owner.clone(),
            priority: self.priority,
        }
    }

    fn editing(&self) -> Option<&str> {
        match &self.mode {
            Mode::Edit(id) => Some(id),
            _ => None,
        }
    }

    fn ticket(&self, id: &str) -> Option<&Ticket> {
        self.tickets
            .value
            .as_ref()?
            .iter()
            .find(|ticket| ticket.id == id)
    }
}

impl WorkspacePanel {
    /// Opens the board: reads it, then follows its changes while it is on screen.
    pub(crate) fn enter_board(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.load_tickets(window, cx);
        if self.board.live.is_none() && self.board.gate == Gate::Open {
            self.follow_board(window, cx);
        }
    }

    pub(crate) fn refresh_board(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.board.live.is_none() && self.board.gate == Gate::Open {
            self.follow_board(window, cx);
        }
        self.load_tickets(window, cx);
        if self.board.editing().is_some() {
            self.load_comments(window, cx);
        }
    }

    fn follow_board(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (signals, mut received) = unbounded_channel();
        // The request runs on the network runtime until `received` is dropped with the task below.
        drop(remote::request(live::follow(self.remote.clone(), signals)));
        self.board.live = Some(cx.spawn_in(window, async move |panel, cx| {
            while let Some(signal) = received.recv().await {
                if panel
                    .update_in(cx, |panel, window, cx| {
                        panel.board_signal(signal, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    fn board_signal(&mut self, signal: Live, window: &mut Window, cx: &mut Context<Self>) {
        match signal {
            Live::Connected => self.refresh_board(window, cx),
            Live::Changed { ticket_id } => {
                self.load_tickets(window, cx);
                if ticket_id.is_some() && self.board.editing() == ticket_id.as_deref() {
                    self.load_comments(window, cx);
                }
            }
            Live::Refused(error) => {
                self.board.live = None;
                if matches!(Failure::from_error(&error), Failure::Stale(_)) {
                    self.board_turned_off(window, cx);
                }
            }
        }
        cx.notify();
    }

    pub(crate) fn load_tickets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.board.tickets.loading {
            self.board.read_again = true;
            return;
        }
        self.board.tickets.begin();
        self.board.read_again = false;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_tickets().await },
            |panel, tickets, window, cx| {
                if matches!(tickets, Err(Failure::Stale(_))) {
                    panel.board.tickets.loading = false;
                    panel.board_turned_off(window, cx);
                    return;
                }
                panel.board.gate = Gate::Open;
                panel.board.tickets.finish(tickets);
                panel.bring_form_up_to_date(window, cx);
                if std::mem::take(&mut panel.board.read_again) {
                    panel.load_tickets(window, cx);
                }
            },
        );
    }

    fn board_turned_off(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.board.stop_live();
        self.board.gate = Gate::Off { labs: None };
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.features().labs().await },
            |panel, labs, _, _| {
                if let (Gate::Off { .. }, Ok(labs)) = (&panel.board.gate, labs) {
                    panel.board.gate = Gate::Off { labs: Some(labs) };
                }
            },
        );
    }

    fn turn_board_on(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Gate::Off { labs: Some(labs) } = self.board.gate.clone() else {
            return;
        };
        self.board.switching_lab = true;
        self.board.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.features().set_board_lab(&labs, true).await },
            |panel, labs, window, cx| {
                panel.board.switching_lab = false;
                match labs {
                    Ok(_) => {
                        panel.board.gate = Gate::Open;
                        panel.board.tickets = Loaded::default();
                        panel.enter_board(window, cx);
                    }
                    Err(failure) => {
                        panel.board.problem = Some(failure.sentence("turn on Board").into())
                    }
                }
            },
        );
        cx.notify();
    }

    /// Applies the server's newest copy of the open ticket without losing what is being typed.
    fn bring_form_up_to_date(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.board.editing().map(str::to_owned) else {
            return;
        };
        let (Some(base), Some(incoming)) =
            (self.board.base.clone(), self.board.ticket(&id).cloned())
        else {
            return;
        };
        if base == incoming {
            return;
        }
        let local = self.board.fields(cx);
        let (merged, conflict) = rebase(&local, &Fields::of(&base), &Fields::of(&incoming));
        if Fields::of(&base) != Fields::of(&incoming) {
            let previous = self.board.changed_elsewhere.unwrap_or(false);
            self.board.changed_elsewhere = Some(previous || conflict);
        }
        self.show_fields(&merged, &local, window, cx);
        self.board.base = Some(incoming);
    }

    /// Puts `fields` in the form, touching only the inputs whose text changes.
    fn show_fields(
        &mut self,
        fields: &Fields,
        shown: &Fields,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if fields.title != shown.title {
            ui::set_input(&self.board.title, &fields.title, window, cx);
        }
        if fields.description != shown.description {
            ui::set_textarea(&self.board.description, &fields.description, window, cx);
        }
        self.board.owner = fields.owner.clone();
        self.board.priority = fields.priority;
    }

    fn replace_ticket(&mut self, ticket: Ticket) {
        if let Some(tickets) = &mut self.board.tickets.value {
            tickets.retain(|existing| existing.id != ticket.id);
            tickets.insert(0, ticket);
        }
    }

    fn start_new_ticket(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.board.close();
        self.board.mode = Mode::Create;
        let owner = self
            .bots
            .value
            .as_ref()
            .and_then(|bots| bots.first())
            .map(|bot| bot.id.clone());
        let blank = Fields {
            title: String::new(),
            description: String::new(),
            owner,
            priority: Default::default(),
        };
        let shown = self.board.fields(cx);
        self.show_fields(&blank, &shown, window, cx);
        self.board
            .title
            .update(cx, |title, cx| title.focus(window, cx));
        cx.notify();
    }

    fn open_ticket(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ticket) = self.board.ticket(&id).cloned() else {
            return;
        };
        self.board.close();
        let shown = self.board.fields(cx);
        self.show_fields(&Fields::of(&ticket), &shown, window, cx);
        ui::set_textarea(&self.board.comment, "", window, cx);
        self.board.base = Some(ticket);
        self.board.mode = Mode::Edit(id);
        self.load_comments(window, cx);
        cx.notify();
    }

    fn load_comments(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.board.editing().map(str::to_owned) else {
            return;
        };
        if self.board.comments.untouched() {
            self.board.comments.begin();
        }
        let remote = self.remote.clone();
        let asked = id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().ticket_comments(&asked).await },
            move |panel, comments, _, _| {
                if panel.board.editing() == Some(id.as_str()) {
                    panel.board.comments.finish(comments);
                }
            },
        );
    }

    fn create_ticket(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let fields = self.board.fields(cx);
        let title = fields.title.trim().to_owned();
        let Some(owner) = fields.owner.clone() else {
            return;
        };
        if title.is_empty() || self.board.saving {
            return;
        }
        self.board.saving = true;
        self.board.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let description = fields.description.trim();
                let input = CreateTicket {
                    title: &title,
                    description: (!description.is_empty()).then_some(fields.description.as_str()),
                    priority: fields.priority,
                    assignee_bot_id: &owner,
                };
                remote.space().create_ticket(&input).await
            },
            |panel, created, window, cx| {
                panel.board.saving = false;
                match created {
                    Ok(ticket) => {
                        let (id, reference) = (ticket.id.clone(), ticket.reference.clone());
                        panel.replace_ticket(ticket);
                        panel.toast(format!("Created {reference}."), None, cx);
                        panel.open_ticket(id, window, cx);
                    }
                    Err(failure) => {
                        panel.board.problem = Some(failure.sentence("create this ticket").into())
                    }
                }
            },
        );
        cx.notify();
    }

    fn save_ticket(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(base) = self.board.base.clone() else {
            return;
        };
        let changes = Changes::between(&self.board.fields(cx), &Fields::of(&base));
        if changes.is_empty() || changes.title.as_deref() == Some("") || self.board.saving {
            return;
        }
        self.board.saving = true;
        self.board.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let update = TicketUpdate {
                    title: changes.title.as_deref(),
                    description: match &changes.description {
                        Patch::Unchanged => Patch::Unchanged,
                        Patch::Clear => Patch::Clear,
                        Patch::Set(text) => Patch::Set(text.as_str()),
                    },
                    priority: changes.priority,
                    assignee_bot_id: changes.owner.as_deref(),
                    status: None,
                };
                remote.space().update_ticket(&base.id, &update).await
            },
            |panel, saved, window, cx| {
                panel.board.saving = false;
                match saved {
                    Ok(ticket) => panel.saved_ticket(ticket, "Saved.".into(), window, cx),
                    Err(failure) => {
                        panel.board.problem = Some(failure.sentence("save this ticket").into())
                    }
                }
            },
        );
        cx.notify();
    }

    fn move_ticket(&mut self, status: TicketStatus, window: &mut Window, cx: &mut Context<Self>) {
        let Some(base) = self.board.base.clone() else {
            return;
        };
        if base.status == status || self.board.moving.is_some() {
            return;
        }
        self.board.moving = Some(status);
        self.board.problem = None;
        let remote = self.remote.clone();
        let id = base.id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().move_ticket(&id, status).await },
            move |panel, moved, window, cx| {
                panel.board.moving = None;
                match moved {
                    Ok(ticket) => {
                        let message = format!("Moved {} to {}.", ticket.reference, status.label());
                        panel.saved_ticket(ticket, message, window, cx);
                    }
                    Err(failure) => {
                        panel.board.problem = Some(failure.sentence("move this ticket").into())
                    }
                }
            },
        );
        cx.notify();
    }

    /// Takes the server's answer to this person's own change: fields still being edited stay.
    fn saved_ticket(
        &mut self,
        ticket: Ticket,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editing = self.board.editing() == Some(ticket.id.as_str());
        if editing {
            if let Some(base) = self.board.base.clone() {
                let local = self.board.fields(cx);
                let (merged, _) = rebase(&local, &Fields::of(&base), &Fields::of(&ticket));
                self.show_fields(&merged, &local, window, cx);
            }
            self.board.base = Some(ticket.clone());
            self.board.changed_elsewhere = None;
        }
        self.replace_ticket(ticket);
        self.toast(message, None, cx);
    }

    fn post_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.board.editing().map(str::to_owned) else {
            return;
        };
        let body = self.board.comment.read(cx).value().trim().to_owned();
        if body.is_empty() || self.board.commenting {
            return;
        }
        self.board.commenting = true;
        self.board.problem = None;
        let remote = self.remote.clone();
        let asked = id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().comment_ticket(&asked, &body).await },
            move |panel, posted, window, cx| {
                panel.board.commenting = false;
                match posted {
                    Ok(comment) => {
                        if panel.board.editing() != Some(id.as_str()) {
                            return;
                        }
                        if let Some(comments) = &mut panel.board.comments.value {
                            if !comments.iter().any(|existing| existing.id == comment.id) {
                                comments.push(comment);
                            }
                        }
                        ui::set_textarea(&panel.board.comment, "", window, cx);
                    }
                    Err(failure) => {
                        panel.board.problem = Some(failure.sentence("post this comment").into())
                    }
                }
            },
        );
        cx.notify();
    }

    fn open_board_on_web(&mut self, cx: &mut Context<Self>) {
        cx.emit(PanelEvent::OpenWeb {
            path: WEB_BOARD.into(),
        });
    }
}
