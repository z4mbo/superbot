use std::collections::HashMap;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_client::Error;
use superbot_t3_inbox::{self as t3, Grant, GrantStore, Ledger, PendingSignIn, Project, Receipt, Start, T3Error};

use crate::api::{self, AppRecord, Installation, Manifest, RecordQuery};
use crate::app::Desktop;
use crate::runtime::network;
use crate::theme::{radius, Theme};
use crate::ui::{chip, empty_line, error_line, field_box, icon, pill_button, Tone, Type};

use super::{back_button, plugin_mark};

/// Receipt pages read to find earlier starts; older receipts still block a repeat through the
/// local ledger.
const RECEIPT_PAGES: usize = 25;

/// Only the bundled, approved inbox the server seeded opens here. A community plugin with the
/// same name or slug keeps the generic app view and never reaches T3.
pub fn is_bundled(installation: &Installation) -> bool {
    let version = &installation.plugin;
    version.id == t3::BUNDLED_VERSION_ID
        && version.slug == t3::SLUG
        && version.status == "approved"
        && serde_json::from_str::<Manifest>(t3::MANIFEST).is_ok_and(|manifest| manifest == version.manifest)
}

enum Link {
    Loading,
    Missing,
    /// The operator is approving the sign-in in T3. Dropping the task stops listening for it.
    SigningIn {
        authorization_url: String,
        _task: Task<()>,
    },
    Connected(Grant),
}

struct Requests {
    records: Vec<AppRecord>,
    next_after: Option<String>,
}

pub struct T3Inbox {
    installation_id: String,
    version_id: String,
    link: Link,
    url: Entity<InputState>,
    connect_error: Option<String>,
    sign_ins: u64,
    projects: Option<Result<Vec<Project>, String>>,
    project: Option<String>,
    requests: Option<Result<Requests, String>>,
    receipts: HashMap<String, Receipt>,
    reads: u64,
    loading_more: bool,
    open: Option<String>,
    confirming: bool,
    starting: bool,
    start_problem: Option<String>,
    /// T3 accepted this start but its receipt could not be saved to the inbox yet.
    unsaved: Option<Unsaved>,
    _submit: Subscription,
}

struct Outcome {
    receipt: Receipt,
    operation_id: String,
    saved: Result<(), String>,
}

struct Unsaved {
    receipt: Receipt,
    operation_id: String,
    problem: String,
}

async fn save_receipt(
    api: &api::Api,
    space_id: &str,
    installation_id: &str,
    operation_id: &str,
    receipt: &Receipt,
) -> Result<(), String> {
    let values = receipt.values();
    match api.add_app_record(space_id, installation_id, t3::DISPATCHES, operation_id, &values).await {
        Ok(record) if record.values == values => Ok(()),
        Ok(_) | Err(Error::Server { status: 409, .. }) => {
            Err("The inbox already holds a different receipt for this start. Check it in T3.".to_owned())
        }
        Err(error) => Err(api::explain(&error)),
    }
}

fn text_value<'a>(record: &'a AppRecord, field: &str) -> &'a str {
    record.values.get(field).and_then(|value| value.as_str()).unwrap_or_default()
}

fn first_line(text: &str) -> String {
    let line = text.lines().find(|line| !line.trim().is_empty()).unwrap_or_default().trim();
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(119).collect::<String>())
    } else {
        line.to_owned()
    }
}

fn t3_problem(error: &T3Error) -> String {
    error.to_string()
}

/// Every receipt the inbox holds, newest first, keyed by the request it started.
async fn read_receipts(
    api: &api::Api,
    space_id: &str,
    installation_id: &str,
) -> Result<HashMap<String, Receipt>, Error> {
    let mut receipts = HashMap::new();
    let mut query = RecordQuery::default();
    for _ in 0..RECEIPT_PAGES {
        let page = api.app_records(space_id, installation_id, t3::DISPATCHES, &query).await?;
        for record in &page.items {
            if let Some(receipt) = Receipt::from_values(&record.values) {
                receipts.entry(receipt.request_id.clone()).or_insert(receipt);
            }
        }
        match page.next_after {
            Some(after) if query.after.as_ref() != Some(&after) => query.after = Some(after),
            _ => break,
        }
    }
    Ok(receipts)
}

impl Desktop {
    pub(super) fn open_t3_inbox(&mut self, installation: &Installation, window: &mut Window, cx: &mut Context<Self>) {
        let url = cx.new(|cx| InputState::new(window, cx).placeholder("http://127.0.0.1:3773/mcp"));
        let submit = cx.subscribe_in(&url, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.connect_t3(window, cx);
            }
        });
        self.store.t3 = Some(T3Inbox {
            installation_id: installation.id.clone(),
            version_id: installation.plugin.id.clone(),
            link: Link::Loading,
            url,
            connect_error: None,
            sign_ins: 0,
            projects: None,
            project: None,
            requests: None,
            receipts: HashMap::new(),
            reads: 0,
            loading_more: false,
            open: None,
            confirming: false,
            starting: false,
            start_problem: None,
            unsaved: None,
            _submit: submit,
        });
        self.load_t3_grant(window, cx);
        self.load_t3_records(window, cx);
        cx.notify();
    }

    fn t3_grants(&self) -> Option<GrantStore> {
        Some(GrantStore::new(self.api.as_ref()?.client.server(), &self.me.as_ref()?.user_id))
    }

    fn load_t3_grant(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(grants) = self.t3_grants() else { return };
        self.call(window, cx, async move { Ok(grants.load().await) }, |this, result, window, cx| {
            let Some(inbox) = this.store.t3.as_mut() else { return };
            match result {
                Ok(Ok(Some(grant))) => {
                    inbox.link = Link::Connected(grant);
                    this.load_t3_projects(window, cx);
                }
                Ok(Ok(None)) => inbox.link = Link::Missing,
                Ok(Err(error)) => {
                    inbox.link = Link::Missing;
                    inbox.connect_error = Some(t3_problem(&error));
                }
                Err(error) => {
                    inbox.link = Link::Missing;
                    inbox.connect_error = Some(api::explain(&error));
                }
            }
        });
    }

    /// Reads the newest requests again, or the page after those shown, with every receipt.
    pub(super) fn load_t3_records(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.read_t3_records(false, window, cx);
    }

    fn read_t3_records(&mut self, more: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(inbox) = self.store.t3.as_mut() else { return };
        let after = match (&inbox.requests, more) {
            (Some(Ok(shown)), true) => match &shown.next_after {
                Some(after) => Some(after.clone()),
                None => return,
            },
            _ => None,
        };
        inbox.reads += 1;
        inbox.loading_more = more;
        let read = inbox.reads;
        let installation_id = inbox.installation_id.clone();
        let work = async move {
            let query = RecordQuery { after, date: None };
            let page = api.app_records(&space_id, &installation_id, t3::REQUESTS, &query).await?;
            let receipts = read_receipts(&api, &space_id, &installation_id).await?;
            Ok((page, receipts))
        };
        self.call(window, cx, work, move |this, result, _, _| {
            let Some(inbox) = this.store.t3.as_mut().filter(|inbox| inbox.reads == read) else { return };
            inbox.loading_more = false;
            match result {
                Ok((page, receipts)) => {
                    inbox.receipts = receipts;
                    if let Some(Unsaved { receipt, .. }) = &inbox.unsaved {
                        if inbox.receipts.contains_key(&receipt.request_id) {
                            inbox.unsaved = None;
                        } else {
                            inbox.receipts.insert(receipt.request_id.clone(), receipt.clone());
                        }
                    }
                    inbox.requests = Some(Ok(match inbox.requests.take() {
                        Some(Ok(mut shown)) if more => {
                            shown.records.extend(page.items);
                            shown.next_after = page.next_after;
                            shown
                        }
                        _ => Requests { records: page.items, next_after: page.next_after },
                    }));
                }
                Err(error) => inbox.requests = Some(Err(api::explain(&error))),
            }
        });
        cx.notify();
    }

    fn load_t3_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(inbox) = self.store.t3.as_mut() else { return };
        let Link::Connected(grant) = &inbox.link else { return };
        let grant = grant.clone();
        inbox.projects = None;
        self.call(window, cx, async move { Ok(t3::projects(&grant).await) }, |this, result, _, _| {
            let Some(inbox) = this.store.t3.as_mut() else { return };
            let projects = match result {
                Ok(found) => found.map_err(|error| t3_problem(&error)),
                Err(error) => Err(api::explain(&error)),
            };
            if let Ok(found) = &projects {
                if inbox.project.as_ref().is_none_or(|chosen| !found.iter().any(|project| &project.id == chosen)) {
                    inbox.project = (found.len() == 1).then(|| found[0].id.clone());
                }
            }
            inbox.projects = Some(projects);
        });
    }

    fn connect_t3(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(inbox) = self.store.t3.as_mut() else { return };
        if !matches!(inbox.link, Link::Missing) {
            return;
        }
        let typed = inbox.url.read(cx).value().to_string();
        let endpoint = match t3::mcp_endpoint(&typed) {
            Ok(endpoint) => endpoint.to_string(),
            Err(error) => {
                inbox.connect_error = Some(t3_problem(&error));
                cx.notify();
                return;
            }
        };
        inbox.connect_error = None;
        inbox.sign_ins += 1;
        let attempt = inbox.sign_ins;
        let task = cx.spawn_in(window, async move |this, cx| {
            let begun = network(async move { Ok(t3::begin_sign_in(&endpoint).await) }).await;
            let pending: PendingSignIn = match begun {
                Ok(Ok(pending)) => pending,
                Ok(Err(error)) => {
                    return this
                        .update(cx, |this, cx| this.t3_sign_in_failed(attempt, t3_problem(&error), cx))
                        .unwrap_or(())
                }
                Err(error) => {
                    return this
                        .update(cx, |this, cx| this.t3_sign_in_failed(attempt, api::explain(&error), cx))
                        .unwrap_or(())
                }
            };
            let authorization_url = pending.authorization_url.to_string();
            let current = this
                .update(cx, |this, cx| {
                    let Some(inbox) = this.store.t3.as_mut().filter(|inbox| inbox.sign_ins == attempt) else {
                        return false;
                    };
                    if let Link::SigningIn { authorization_url: shown, .. } = &mut inbox.link {
                        shown.clone_from(&authorization_url);
                    }
                    cx.open_url(&authorization_url);
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let finished = network(async move { Ok(pending.finish().await) }).await;
            let grant = match finished {
                Ok(Ok(grant)) => grant,
                Ok(Err(error)) => {
                    return this
                        .update(cx, |this, cx| this.t3_sign_in_failed(attempt, t3_problem(&error), cx))
                        .unwrap_or(())
                }
                Err(error) => {
                    return this
                        .update(cx, |this, cx| this.t3_sign_in_failed(attempt, api::explain(&error), cx))
                        .unwrap_or(())
                }
            };
            let _ = this.update_in(cx, |this, window, cx| this.t3_signed_in(attempt, grant, window, cx));
        });
        inbox.link = Link::SigningIn { authorization_url: String::new(), _task: task };
        cx.notify();
    }

    fn t3_sign_in_failed(&mut self, attempt: u64, problem: String, cx: &mut Context<Self>) {
        let Some(inbox) = self.store.t3.as_mut().filter(|inbox| inbox.sign_ins == attempt) else { return };
        inbox.link = Link::Missing;
        inbox.connect_error = Some(problem);
        cx.notify();
    }

    fn t3_signed_in(&mut self, attempt: u64, grant: Grant, window: &mut Window, cx: &mut Context<Self>) {
        let Some(grants) = self.t3_grants() else { return };
        if self.store.t3.as_ref().is_none_or(|inbox| inbox.sign_ins != attempt) {
            return;
        }
        let saving = grant.clone();
        self.call(window, cx, async move { Ok(grants.save(&saving).await) }, move |this, result, window, cx| {
            let Some(inbox) = this.store.t3.as_mut().filter(|inbox| inbox.sign_ins == attempt) else { return };
            match result {
                Ok(Ok(())) => {
                    inbox.link = Link::Connected(grant);
                    this.load_t3_projects(window, cx);
                }
                Ok(Err(error)) => {
                    inbox.link = Link::Missing;
                    inbox.connect_error = Some(t3_problem(&error));
                }
                Err(error) => {
                    inbox.link = Link::Missing;
                    inbox.connect_error = Some(api::explain(&error));
                }
            }
        });
    }

    fn cancel_t3_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(inbox) = self.store.t3.as_mut() else { return };
        inbox.sign_ins += 1;
        inbox.link = Link::Missing;
        cx.notify();
    }

    /// Forgets the grant on this computer. Saved plans and receipts stay, so a pending start can
    /// still be reconciled.
    fn disconnect_t3(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(grants) = self.t3_grants() else { return };
        self.call(window, cx, async move { Ok(grants.forget().await) }, |this, result, _, cx| {
            let Some(inbox) = this.store.t3.as_mut() else { return };
            match result {
                Ok(Ok(())) => {
                    inbox.link = Link::Missing;
                    inbox.projects = None;
                    inbox.project = None;
                    inbox.confirming = false;
                }
                Ok(Err(error)) => this.notify(t3_problem(&error), true, None, cx),
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
    }

    fn start_t3_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(directory) = superbot_client::settings_directory() else {
            self.notify("This computer has no folder for Superbot settings.", true, None, cx);
            return;
        };
        let server = api.client.server().trim_end_matches('/').to_owned();
        let Some(inbox) = self.store.t3.as_mut().filter(|inbox| !inbox.starting) else { return };
        let Link::Connected(grant) = &inbox.link else { return };
        let (Some(project_id), Some(record_id)) = (inbox.project.clone(), inbox.open.clone()) else { return };
        let Some(Ok(requests)) = &inbox.requests else { return };
        let Some(record) = requests.records.iter().find(|record| record.id == record_id) else { return };
        let (title, brief) = (text_value(record, "title").to_owned(), text_value(record, "brief").to_owned());
        let (grant, installation_id) = (grant.clone(), inbox.installation_id.clone());
        inbox.starting = true;
        inbox.start_problem = None;
        inbox.unsaved = None;
        let work = async move {
            if let Some(receipt) = read_receipts(&api, &space_id, &installation_id).await?.remove(&record_id) {
                return Ok(Ok(Outcome { receipt, operation_id: String::new(), saved: Ok(()) }));
            }
            let ledger = Ledger::new(directory.join("t3-code-inbox"));
            let start = Start {
                server: &server,
                space: &space_id,
                installation: &installation_id,
                record_id: &record_id,
                project_id: &project_id,
                title: &title,
                brief: &brief,
            };
            let started = match t3::start(&ledger, &grant, &start).await {
                Ok(started) => started,
                Err(error) => return Ok(Err(t3_problem(&error))),
            };
            let operation_id = started.plan.operation_id;
            let saved = save_receipt(&api, &space_id, &installation_id, &operation_id, &started.receipt).await;
            Ok(Ok(Outcome { receipt: started.receipt, operation_id, saved }))
        };
        self.call(window, cx, work, |this, result, window, cx| {
            let Some(inbox) = this.store.t3.as_mut() else { return };
            inbox.starting = false;
            match result {
                Ok(Ok(outcome)) => {
                    inbox.confirming = false;
                    inbox.unsaved = outcome.saved.err().map(|problem| Unsaved {
                        receipt: outcome.receipt.clone(),
                        operation_id: outcome.operation_id,
                        problem,
                    });
                    inbox.receipts.insert(outcome.receipt.request_id.clone(), outcome.receipt);
                    this.load_t3_records(window, cx);
                }
                Ok(Err(problem)) => inbox.start_problem = Some(problem),
                Err(error) => inbox.start_problem = Some(api::explain(&error)),
            }
        });
        cx.notify();
    }

    /// Saves a receipt T3 already returned, under the start's own operation ID.
    fn retry_t3_receipt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(inbox) = self.store.t3.as_mut().filter(|inbox| !inbox.starting) else { return };
        let Some(unsaved) = &inbox.unsaved else { return };
        let (receipt, operation_id) = (unsaved.receipt.clone(), unsaved.operation_id.clone());
        let installation_id = inbox.installation_id.clone();
        inbox.starting = true;
        let work = async move { Ok(save_receipt(&api, &space_id, &installation_id, &operation_id, &receipt).await) };
        self.call(window, cx, work, |this, result, window, cx| {
            let Some(inbox) = this.store.t3.as_mut() else { return };
            inbox.starting = false;
            match result.map_err(|error| api::explain(&error)).and_then(|saved| saved) {
                Ok(()) => {
                    inbox.unsaved = None;
                    this.load_t3_records(window, cx);
                }
                Err(problem) => {
                    if let Some(unsaved) = inbox.unsaved.as_mut() {
                        unsaved.problem = problem;
                    }
                }
            }
        });
        cx.notify();
    }

    pub(super) fn render_t3_inbox(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let inbox = self.store.t3.as_ref().expect("an open T3 inbox");
        let installation = self
            .store
            .installations
            .iter()
            .find(|known| known.id == inbox.installation_id && known.plugin.id == inbox.version_id)
            .cloned();
        let back = back_button(theme).on_click(cx.listener(|this, _, _, cx| {
            this.store.t3 = None;
            cx.notify();
        }));
        let Some(installation) = installation else {
            return div()
                .flex()
                .flex_col()
                .gap_3()
                .child(back)
                .child(empty_line("This app was uninstalled or moved to another version.", theme))
                .into_any_element();
        };
        let status = match &inbox.link {
            Link::Connected(grant) => Some(format!("Connected to T3 at {}", grant.place())),
            _ => None,
        };
        let header = div()
            .flex()
            .items_center()
            .gap_3()
            .child(back)
            .child(plugin_mark(&installation.plugin, px(40.), theme))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().title().truncate().child(installation.plugin.manifest.name.clone()))
                    .children(status.map(|line| div().meta().text_color(theme.ink_tertiary).child(line))),
            )
            .when(matches!(inbox.link, Link::Connected(_)), |header| {
                header.child(
                    pill_button("t3-disconnect", "Disconnect", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.disconnect_t3(window, cx))),
                )
            });

        div()
            .id("t3-inbox")
            .size_full()
            .overflow_y_scroll()
            .pb_8()
            .flex()
            .flex_col()
            .gap_6()
            .child(header)
            .children(self.render_t3_connect(theme, cx))
            .children(self.render_t3_projects(theme, cx))
            .child(self.render_t3_requests(theme, cx))
            .into_any_element()
    }

    fn render_t3_connect(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let inbox = self.store.t3.as_ref()?;
        let panel = div()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .rounded(radius::CARD)
            .bg(theme.ink_at(0.03))
            .border_1()
            .border_color(theme.hairline.opacity(0.5));
        let body = match &inbox.link {
            Link::Connected(_) => return None,
            Link::Loading => panel.child(empty_line("Loading…", theme)),
            Link::SigningIn { authorization_url, .. } => {
                let reopen = authorization_url.clone();
                panel.child(div().item().child("Approve Superbot T3 Code inbox in the T3 page that opened.")).child(
                    div()
                        .flex()
                        .gap_2()
                        .when(!reopen.is_empty(), |row| {
                            row.child(
                                pill_button("t3-reopen", "Open again", Tone::Quiet, true, theme)
                                    .on_click(move |_, _, cx| cx.open_url(&reopen)),
                            )
                        })
                        .child(
                            pill_button("t3-cancel-sign-in", "Cancel", Tone::Quiet, true, theme)
                                .on_click(cx.listener(|this, _, _, cx| this.cancel_t3_sign_in(cx))),
                        ),
                )
            }
            Link::Missing => panel
                .child(
                    div()
                        .flex()
                        .items_end()
                        .gap_3()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap_1p5()
                                .child(
                                    div()
                                        .meta()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.ink_tertiary)
                                        .child("T3 MCP URL, from T3 Settings"),
                                )
                                .child(
                                    field_box(theme).child(Input::new(&inbox.url).appearance(false).bordered(false)),
                                ),
                        )
                        .child(
                            pill_button("t3-connect", "Connect T3", Tone::Primary, true, theme)
                                .mb(px(2.))
                                .on_click(cx.listener(|this, _, window, cx| this.connect_t3(window, cx))),
                        ),
                )
                .children(inbox.connect_error.clone().map(|problem| error_line(problem, theme))),
        };
        Some(body)
    }

    fn render_t3_projects(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let inbox = self.store.t3.as_ref()?;
        if !matches!(inbox.link, Link::Connected(_)) {
            return None;
        }
        let label = div().w(px(72.)).flex_shrink_0().body().text_color(theme.ink_secondary).child("Start in");
        let choices = match &inbox.projects {
            None => empty_line("Loading projects…", theme).into_any_element(),
            Some(Err(problem)) => div()
                .flex()
                .flex_col()
                .items_start()
                .gap_2()
                .child(error_line(problem.clone(), theme))
                .child(
                    pill_button("t3-projects-retry", "Try again", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.load_t3_projects(window, cx))),
                )
                .into_any_element(),
            Some(Ok(projects)) if projects.is_empty() => {
                empty_line("This T3 has no projects. Add one in T3, then reopen this page.", theme).into_any_element()
            }
            Some(Ok(projects)) => div()
                .flex()
                .flex_wrap()
                .gap_2()
                .children(projects.iter().map(|project| {
                    let id = project.id.clone();
                    chip(
                        SharedString::from(format!("t3-project-{}", project.id)),
                        project.title.clone(),
                        inbox.project.as_ref() == Some(&project.id),
                        theme,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(inbox) = this.store.t3.as_mut().filter(|inbox| !inbox.starting) {
                            inbox.project = Some(id.clone());
                            inbox.confirming = false;
                        }
                        cx.notify();
                    }))
                }))
                .into_any_element(),
        };
        Some(div().flex().items_start().gap_3().child(label.pt(px(7.))).child(div().flex_1().min_w_0().child(choices)))
    }

    fn render_t3_requests(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let inbox = self.store.t3.as_ref().expect("an open T3 inbox");
        let heading = div().section().child("Requests");
        let body = match &inbox.requests {
            None => empty_line("Loading…", theme).into_any_element(),
            Some(Err(problem)) => div()
                .flex()
                .flex_col()
                .items_start()
                .gap_3()
                .child(error_line(problem.clone(), theme))
                .child(
                    pill_button("t3-requests-retry", "Try again", Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.load_t3_records(window, cx))),
                )
                .into_any_element(),
            Some(Ok(requests)) if requests.records.is_empty() => {
                empty_line("No requests yet. Ask a bot to propose coding work.", theme).into_any_element()
            }
            Some(Ok(requests)) => {
                let rows: Vec<AnyElement> =
                    requests.records.iter().map(|record| self.render_t3_request(record, theme, cx)).collect();
                let more = requests.next_after.is_some();
                let loading = inbox.loading_more;
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(rows)
                    .when(more, |list| {
                        list.child(
                            pill_button(
                                "t3-more",
                                if loading { "Loading…" } else { "Show more" },
                                Tone::Quiet,
                                !loading,
                                theme,
                            )
                            .mt_2()
                            .on_click(cx.listener(|this, _, window, cx| this.read_t3_records(true, window, cx))),
                        )
                    })
                    .into_any_element()
            }
        };
        div().flex().flex_col().gap_3().child(heading).child(body)
    }

    fn render_t3_request(&self, record: &AppRecord, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let inbox = self.store.t3.as_ref().expect("an open T3 inbox");
        let (title, brief) = (text_value(record, "title"), text_value(record, "brief"));
        let receipt = inbox.receipts.get(&record.id);
        let open = inbox.open.as_deref() == Some(record.id.as_str());
        let hover = theme.raised.opacity(0.4);
        let id = record.id.clone();
        let summary = div()
            .id(SharedString::from(format!("t3-request-{}", record.id)))
            .flex()
            .items_center()
            .gap_3()
            .px_2()
            .py_2()
            .rounded(radius::CARD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .child(
                div().flex_1().min_w_0().child(div().item().truncate().child(title.to_owned())).when(!open, |cell| {
                    cell.child(div().meta().text_color(theme.ink_tertiary).truncate().child(first_line(brief)))
                }),
            )
            .children(receipt.map(|_| {
                div()
                    .px_2()
                    .py_0p5()
                    .rounded_full()
                    .bg(theme.ink_at(0.06))
                    .meta()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink_secondary)
                    .child("Started")
            }))
            .child(icon(if open { "chevron-up" } else { "chevron-down" }, px(14.), theme.ink_tertiary))
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(inbox) = this.store.t3.as_mut().filter(|inbox| !inbox.starting) {
                    inbox.open = if inbox.open.as_ref() == Some(&id) { None } else { Some(id.clone()) };
                    inbox.confirming = false;
                    inbox.start_problem = None;
                }
                cx.notify();
            }));
        let detail = open.then(|| self.render_t3_detail(record, receipt, theme, cx));
        div().flex().flex_col().child(summary).children(detail).into_any_element()
    }

    fn render_t3_detail(
        &self,
        record: &AppRecord,
        receipt: Option<&Receipt>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let inbox = self.store.t3.as_ref().expect("an open T3 inbox");
        let brief = div()
            .p_3()
            .rounded(radius::FIELD)
            .bg(theme.inset)
            .border_1()
            .border_color(theme.hairline.opacity(0.5))
            .body()
            .text_color(theme.ink)
            .child(text_value(record, "brief").to_owned());
        let actions = match receipt {
            Some(receipt) => self.render_t3_receipt(receipt, theme),
            None => self.render_t3_start(record, theme, cx),
        };
        div().ml_2().mb_3().flex().flex_col().gap_3().child(brief).child(actions).children(
            inbox.unsaved.as_ref().filter(|unsaved| unsaved.receipt.request_id == record.id).map(|unsaved| {
                let saving = inbox.starting;
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap_2()
                    .child(error_line(
                        format!("T3 started it, but its receipt isn't in the inbox yet. {}", unsaved.problem),
                        theme,
                    ))
                    .child(
                        pill_button(
                            "t3-save-receipt",
                            if saving { "Saving…" } else { "Save receipt" },
                            Tone::Quiet,
                            !saving,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.retry_t3_receipt(window, cx))),
                    )
            }),
        )
    }

    fn render_t3_receipt(&self, receipt: &Receipt, theme: &Theme) -> Div {
        let link = receipt.thread_link.clone();
        div()
            .flex()
            .items_center()
            .gap_3()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().body().child(format!("Started in T3 · {}", receipt.status)))
                    .child(div().meta().text_color(theme.ink_tertiary).truncate().child(receipt.thread_link.clone())),
            )
            .child(
                pill_button(
                    SharedString::from(format!("t3-open-{}", receipt.thread_id)),
                    "Open in T3",
                    Tone::Quiet,
                    true,
                    theme,
                )
                .on_click(move |_, _, cx| cx.open_url(&link)),
            )
    }

    fn render_t3_start(&self, record: &AppRecord, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let inbox = self.store.t3.as_ref().expect("an open T3 inbox");
        let connected = matches!(inbox.link, Link::Connected(_));
        let project = inbox
            .projects
            .as_ref()
            .and_then(|projects| projects.as_ref().ok())
            .and_then(|projects| projects.iter().find(|project| Some(&project.id) == inbox.project.as_ref()));
        let problem = inbox.start_problem.clone().map(|problem| error_line(problem, theme));
        let row = div().flex().flex_col().gap_3();
        let Some(project) = project.filter(|_| connected) else {
            let hint = if connected { "Choose a project to start this in." } else { "Connect T3 to start this." };
            return row.child(empty_line(hint, theme)).children(problem);
        };
        if !inbox.confirming {
            return row
                .child(div().flex().child(pill_button("t3-start", "Start in T3", Tone::Primary, true, theme).on_click(
                    cx.listener(|this, _, _, cx| {
                        if let Some(inbox) = this.store.t3.as_mut() {
                            inbox.confirming = true;
                            inbox.start_problem = None;
                        }
                        cx.notify();
                    }),
                )))
                .children(problem);
        }
        let starting = inbox.starting;
        let title = text_value(record, "title");
        row.child(
            div()
                .flex()
                .flex_col()
                .gap_3()
                .p_3()
                .rounded(radius::CARD)
                .bg(theme.ink_at(0.03))
                .border_1()
                .border_color(theme.hairline.opacity(0.5))
                .child(div().item().child(format!("Start “{title}” in {}?", project.title)))
                .child(
                    div()
                        .body()
                        .text_color(theme.ink_secondary)
                        .child("T3 runs this brief in Supervised mode. Approve its edits in T3."),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(pill_button("t3-start-cancel", "Cancel", Tone::Quiet, !starting, theme).on_click(
                            cx.listener(|this, _, _, cx| {
                                if let Some(inbox) = this.store.t3.as_mut().filter(|inbox| !inbox.starting) {
                                    inbox.confirming = false;
                                }
                                cx.notify();
                            }),
                        ))
                        .child(
                            pill_button(
                                "t3-start-confirm",
                                if starting { "Starting…" } else { "Start" },
                                Tone::Primary,
                                !starting,
                                theme,
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.start_t3_request(window, cx))),
                        ),
                ),
        )
        .children(problem)
    }
}

#[cfg(test)]
mod tests {
    use superbot_t3_inbox as t3;

    use super::{first_line, is_bundled};
    use crate::api::{Installation, Manifest, PluginVersion};

    fn installation(id: &str, slug: &str, status: &str, manifest: &str) -> Installation {
        Installation {
            id: "install-1".into(),
            plugin: PluginVersion {
                id: id.into(),
                slug: slug.into(),
                version: 1,
                manifest: serde_json::from_str::<Manifest>(manifest).unwrap(),
                status: status.into(),
                reason: None,
            },
            grants: Vec::new(),
        }
    }

    #[test]
    fn only_the_seeded_approved_version_opens_the_t3_view() {
        assert!(is_bundled(&installation(t3::BUNDLED_VERSION_ID, t3::SLUG, "approved", t3::MANIFEST)));
        assert!(!is_bundled(&installation("community-version", t3::SLUG, "approved", t3::MANIFEST)));
        assert!(!is_bundled(&installation(t3::BUNDLED_VERSION_ID, "t3-code-inbox-copy", "approved", t3::MANIFEST)));
        assert!(!is_bundled(&installation(t3::BUNDLED_VERSION_ID, t3::SLUG, "pending", t3::MANIFEST)));
        let renamed = t3::MANIFEST.replace("T3 Code inbox", "T3 Code inbox (copy)");
        assert!(!is_bundled(&installation(t3::BUNDLED_VERSION_ID, t3::SLUG, "approved", &renamed)));
    }

    #[test]
    fn a_brief_preview_is_its_first_line() {
        assert_eq!(first_line("\n  Add a test \nThen run it"), "Add a test");
        assert_eq!(first_line(&"x".repeat(200)).chars().count(), 120);
    }
}
