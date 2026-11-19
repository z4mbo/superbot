use gpui_kit::component::input::InputState;
use gpui_kit::prelude::*;
use gpui_kit::{div, App, Div, Entity, SharedString, Window};
use superbot_features::{Group, GroupSettings};

use crate::icons::{icon, Glyph};
use crate::panel::{
    detail_header, placeholder, section_header, Loaded, PanelEvent, Undo, WorkspacePanel,
};
use crate::remote::Failure;
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Toggle, Tone};

#[derive(Clone, PartialEq, Eq)]
enum Mode {
    List,
    Create,
    Edit(String),
}

// The server accepts a group of two to ten bots.
const GROUP_SIZE: std::ops::RangeInclusive<usize> = 2..=10;

pub(crate) struct GroupsView {
    mode: Mode,
    name: Entity<InputState>,
    /// The bots switched on in the open form, in the order they were chosen.
    chosen: Vec<String>,
    snapshot: Option<Group>,
    saving: bool,
    busy: Option<&'static str>,
    problem: Option<SharedString>,
    archived: Loaded<Vec<Group>>,
    show_archived: bool,
    confirm_remove: Option<String>,
}

fn member_ids(group: &Group) -> Vec<String> {
    group
        .members
        .iter()
        .map(|member| member.bot_id.clone())
        .collect()
}

fn summary(group: &Group) -> String {
    let names: Vec<&str> = group
        .members
        .iter()
        .map(|member| member.name.as_str())
        .collect();
    names.join(", ")
}

impl GroupsView {
    pub(crate) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            mode: Mode::List,
            name: ui::new_input("Name", window, cx),
            chosen: Vec::new(),
            snapshot: None,
            saving: false,
            busy: None,
            problem: None,
            archived: Loaded::default(),
            show_archived: false,
            confirm_remove: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.close();
        self.archived = Loaded::default();
        self.show_archived = false;
    }

    pub(crate) fn close(&mut self) {
        self.mode = Mode::List;
        self.snapshot = None;
        self.chosen.clear();
        self.saving = false;
        self.busy = None;
        self.problem = None;
        self.confirm_remove = None;
    }

    fn dirty(&self, cx: &App) -> bool {
        self.snapshot.as_ref().is_some_and(|group| {
            self.name.read(cx).value().trim() != group.name || self.chosen != member_ids(group)
        })
    }
}

impl WorkspacePanel {
    fn replace_group(&mut self, group: Group) {
        if let Some(groups) = &mut self.groups.value {
            match groups.iter_mut().find(|existing| existing.id == group.id) {
                Some(existing) => *existing = group,
                None => groups.push(group),
            }
        }
    }

    fn start_new_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = &mut self.groups_view;
        view.close();
        view.mode = Mode::Create;
        ui::set_input(&view.name, "", window, cx);
        view.name.update(cx, |name, cx| name.focus(window, cx));
        cx.notify();
    }

    fn edit_group(&mut self, group_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self
            .groups
            .value
            .as_ref()
            .and_then(|groups| groups.iter().find(|group| group.id == group_id))
            .cloned()
        else {
            return;
        };
        let view = &mut self.groups_view;
        view.close();
        ui::set_input(&view.name, &group.name, window, cx);
        view.chosen = member_ids(&group);
        view.snapshot = Some(group);
        view.mode = Mode::Edit(group_id);
        cx.notify();
    }

    fn toggle_group_bot(&mut self, bot_id: String, on: bool, cx: &mut Context<Self>) {
        let chosen = &mut self.groups_view.chosen;
        chosen.retain(|chosen| *chosen != bot_id);
        if on {
            chosen.push(bot_id);
        }
        cx.notify();
    }

    fn create_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.groups_view.name.read(cx).value().trim().to_owned();
        let bot_ids = self.groups_view.chosen.clone();
        if name.is_empty() || self.groups_view.saving {
            return;
        }
        self.groups_view.saving = true;
        self.groups_view.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let bot_ids: Vec<&str> = bot_ids.iter().map(String::as_str).collect();
                remote.space().create_group(&name, &bot_ids).await
            },
            |panel, created, window, cx| {
                panel.groups_view.saving = false;
                match created {
                    Ok(group) => {
                        let (id, name) = (group.id.clone(), group.name.clone());
                        panel.replace_group(group);
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.toast(format!("Created {name}."), None, cx);
                        panel.edit_group(id, window, cx);
                    }
                    Err(failure) => {
                        panel.groups_view.problem =
                            Some(failure.sentence("create this group").into());
                    }
                }
            },
        );
    }

    fn save_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self.groups_view.snapshot.clone() else {
            return;
        };
        let name = self.groups_view.name.read(cx).value().trim().to_owned();
        if name.is_empty() || self.groups_view.saving {
            return;
        }
        let before = member_ids(&group);
        let name = (name != group.name).then_some(name);
        let bot_ids = (self.groups_view.chosen != before).then(|| self.groups_view.chosen.clone());
        self.groups_view.saving = true;
        self.groups_view.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let bot_ids: Option<Vec<&str>> = bot_ids
                    .as_ref()
                    .map(|ids| ids.iter().map(String::as_str).collect());
                let expected: Vec<&str> = before.iter().map(String::as_str).collect();
                let settings = GroupSettings {
                    name: name.as_deref(),
                    bot_ids: bot_ids.as_deref(),
                    expected_bot_ids: bot_ids.is_some().then_some(expected.as_slice()),
                    ..Default::default()
                };
                remote.space().update_group(&group.id, &settings).await
            },
            |panel, saved, window, cx| {
                panel.groups_view.saving = false;
                match saved {
                    Ok(group) => {
                        let id = group.id.clone();
                        panel.replace_group(group);
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.toast("Saved.", None, cx);
                        panel.edit_group(id, window, cx);
                    }
                    Err(Failure::Stale(_)) => {
                        panel.groups_view.problem = Some(
                            "This group was changed somewhere else. Reload to see the latest, then make your change again."
                                .into(),
                        );
                    }
                    Err(failure) => {
                        panel.groups_view.problem =
                            Some(failure.sentence("save this group").into());
                    }
                }
            },
        );
    }

    fn reload_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Mode::Edit(group_id) = self.groups_view.mode.clone() else {
            return;
        };
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_groups().await },
            move |panel, groups, window, cx| {
                panel.groups.finish(groups);
                panel.edit_group(group_id, window, cx);
            },
        );
    }

    fn set_group_pinned(&mut self, pinned: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = &mut self.groups_view.snapshot else {
            return;
        };
        group.pinned = pinned;
        let group_id = group.id.clone();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let settings = GroupSettings {
                    pinned: Some(pinned),
                    ..Default::default()
                };
                remote.space().update_group(&group_id, &settings).await
            },
            |panel, saved, _, cx| match saved {
                Ok(group) => {
                    panel.replace_group(group);
                    cx.emit(PanelEvent::GroupsChanged);
                }
                Err(failure) => {
                    panel.groups_view.problem = Some(failure.sentence("pin this group").into());
                }
            },
        );
        cx.notify();
    }

    fn duplicate_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group_id) = self
            .groups_view
            .snapshot
            .as_ref()
            .map(|group| group.id.clone())
        else {
            return;
        };
        self.groups_view.busy = Some("duplicate");
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().duplicate_group(&group_id).await },
            |panel, copy, window, cx| {
                panel.groups_view.busy = None;
                match copy {
                    Ok(copy) => {
                        let (id, name) = (copy.id.clone(), copy.name.clone());
                        panel.replace_group(copy);
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.toast(format!("Created {name}."), None, cx);
                        panel.edit_group(id, window, cx);
                    }
                    Err(failure) => {
                        panel.groups_view.problem =
                            Some(failure.sentence("duplicate this group").into());
                    }
                }
            },
        );
    }

    fn archive_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self.groups_view.snapshot.clone() else {
            return;
        };
        self.groups_view.busy = Some("archive");
        let remote = self.remote.clone();
        let group_id = group.id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().archive_group(&group_id).await },
            move |panel, archived, window, cx| {
                panel.groups_view.busy = None;
                match archived {
                    Ok(()) => {
                        if let Some(groups) = &mut panel.groups.value {
                            groups.retain(|existing| existing.id != group.id);
                        }
                        panel.groups_view.close();
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.toast(
                            format!("Archived {}.", group.name),
                            Some(Undo::RestoreGroup(group.id)),
                            cx,
                        );
                        if panel.groups_view.show_archived {
                            panel.load_archived_groups(window, cx);
                        }
                    }
                    Err(failure) => {
                        panel.groups_view.problem =
                            Some(failure.sentence("archive this group").into());
                    }
                }
            },
        );
    }

    pub(crate) fn restore_group(
        &mut self,
        group_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.groups_view.busy = Some("restore");
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().restore_group(&group_id).await },
            |panel, restored, window, cx| {
                panel.groups_view.busy = None;
                match restored {
                    Ok(()) => {
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.load_groups(window, cx);
                        if panel.groups_view.show_archived {
                            panel.load_archived_groups(window, cx);
                        }
                    }
                    Err(failure) => panel.toast(failure.sentence("restore this group"), None, cx),
                }
            },
        );
    }

    fn remove_group(&mut self, group_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.groups_view.busy = Some("remove");
        self.groups_view.confirm_remove = None;
        let remote = self.remote.clone();
        let removed_id = group_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().remove_group(&group_id).await },
            move |panel, removed, _, cx| {
                panel.groups_view.busy = None;
                match removed {
                    Ok(()) => {
                        if let Some(archived) = &mut panel.groups_view.archived.value {
                            archived.retain(|group| group.id != removed_id);
                        }
                        cx.emit(PanelEvent::GroupsChanged);
                        panel.toast("Group removed.", None, cx);
                    }
                    Err(failure) => panel.toast(failure.sentence("remove this group"), None, cx),
                }
            },
        );
    }

    fn load_archived_groups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.groups_view.archived.loading {
            return;
        }
        self.groups_view.archived.begin();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().list_archived_groups().await },
            |panel, archived, _, _| panel.groups_view.archived.finish(archived),
        );
    }

    fn toggle_archived_groups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.groups_view.show_archived = !self.groups_view.show_archived;
        if self.groups_view.show_archived {
            self.load_archived_groups(window, cx);
        }
        cx.notify();
    }

    pub(crate) fn render_groups(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        match self.groups_view.mode.clone() {
            Mode::List => self.render_group_list(&t, cx),
            Mode::Create => self.render_group_form(None, &t, window, cx),
            Mode::Edit(_) => {
                let group = self.groups_view.snapshot.clone();
                self.render_group_form(group, &t, window, cx)
            }
        }
    }

    fn render_group_list(&mut self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let header = section_header(
            "Groups",
            [Action::new("new-group", "New group")
                .tone(Tone::Primary)
                .glyph(Glyph::Plus)
                .on_click(cx.listener(|panel, _, window, cx| panel.start_new_group(window, cx)))],
            t,
        );
        let retry = Action::new("retry-groups", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_groups(window, cx)));
        let list = match placeholder(&self.groups, "load the groups", retry, t) {
            Some(placeholder) => placeholder,
            None => {
                let groups = self.groups.value.as_deref().unwrap_or_default();
                if groups.is_empty() {
                    ui::notice(
                        "No groups yet. A group is one conversation that several bots share.",
                        None,
                        t,
                    )
                } else {
                    div().flex().flex_col().children(groups.iter().map(|group| {
                        let id = group.id.clone();
                        Row::new(
                            SharedString::from(format!("group-{}", group.id)),
                            group.name.clone(),
                        )
                        .leading(group_face(group, t))
                        .detail(summary(group))
                        .when(group.pinned, |row| {
                            row.trailing(icon(Glyph::Pin, 14., t.ink_tertiary))
                        })
                        .trailing(icon(Glyph::ChevronRight, 16., t.ink_tertiary))
                        .on_click(cx.listener(
                            move |panel, _, window, cx| panel.edit_group(id.clone(), window, cx),
                        ))
                    }))
                }
            }
        };

        let view = &self.groups_view;
        let archived =
            div()
                .flex()
                .flex_col()
                .pt_4()
                .child(
                    div().flex().child(
                        Action::new(
                            "toggle-archived-groups",
                            if view.show_archived {
                                "Hide archived"
                            } else {
                                "Show archived"
                            },
                        )
                        .tone(Tone::Quiet)
                        .small()
                        .glyph(Glyph::Archive)
                        .on_click(cx.listener(|panel, _, window, cx| {
                            panel.toggle_archived_groups(window, cx)
                        })),
                    ),
                )
                .when(view.show_archived, |this| {
                    let retry = Action::new("retry-archived-groups", "Try again").on_click(
                        cx.listener(|panel, _, window, cx| panel.load_archived_groups(window, cx)),
                    );
                    this.child(
                        match placeholder(&view.archived, "load archived groups", retry, t) {
                            Some(placeholder) => placeholder,
                            None => {
                                let groups = view.archived.value.as_deref().unwrap_or_default();
                                if groups.is_empty() {
                                    ui::notice("No archived groups.", None, t)
                                } else {
                                    div().flex().flex_col().children(
                                        groups
                                            .iter()
                                            .map(|group| self.render_archived_group(group, t, cx)),
                                    )
                                }
                            }
                        },
                    )
                });

        div()
            .flex()
            .flex_col()
            .child(header)
            .when_some(
                self.groups
                    .failure
                    .as_ref()
                    .filter(|_| self.groups.value.is_some()),
                |this, failure| {
                    this.child(ui::problem_line(failure.sentence("refresh the groups"), t))
                },
            )
            .child(list)
            .child(archived)
    }

    fn render_archived_group(&self, group: &Group, t: &Tokens, cx: &mut Context<Self>) -> Row {
        let view = &self.groups_view;
        let row = Row::new(
            SharedString::from(format!("archived-group-{}", group.id)),
            group.name.clone(),
        )
        .leading(group_face(group, t).opacity(0.6))
        .detail(summary(group));
        if view.confirm_remove.as_deref() == Some(group.id.as_str()) {
            let id = group.id.clone();
            return row
                .trailing(
                    Action::new("confirm-remove-group", "Remove for everyone")
                        .tone(Tone::Danger)
                        .small()
                        .on_click(cx.listener(move |panel, _, window, cx| {
                            panel.remove_group(id.clone(), window, cx)
                        })),
                )
                .trailing(
                    Action::new("keep-group", "Keep")
                        .small()
                        .on_click(cx.listener(|panel, _, _, cx| {
                            panel.groups_view.confirm_remove = None;
                            cx.notify();
                        })),
                );
        }
        let (restore_id, remove_id) = (group.id.clone(), group.id.clone());
        row.trailing(
            Action::new(
                SharedString::from(format!("restore-group-{}", group.id)),
                "Restore",
            )
            .small()
            .glyph(Glyph::ArchiveRestore)
            .disabled(view.busy.is_some())
            .on_click(cx.listener(move |panel, _, window, cx| {
                panel.restore_group(restore_id.clone(), window, cx)
            })),
        )
        .trailing(
            Action::icon(
                SharedString::from(format!("remove-group-{}", group.id)),
                Glyph::Trash,
                "Remove group",
            )
            .small()
            .disabled(view.busy.is_some())
            .on_click(cx.listener(move |panel, _, _, cx| {
                panel.groups_view.confirm_remove = Some(remove_id.clone());
                cx.notify();
            })),
        )
    }

    fn render_group_form(
        &mut self,
        group: Option<Group>,
        t: &Tokens,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let view = &self.groups_view;
        let name_missing = view.name.read(cx).value().trim().is_empty();
        let enough_bots = GROUP_SIZE.contains(&view.chosen.len());
        let back = Action::icon("groups-back", Glyph::ChevronLeft, "Back to groups").on_click(
            cx.listener(|panel, _, _, cx| {
                panel.groups_view.close();
                cx.notify();
            }),
        );
        let title: SharedString = match &group {
            Some(group) => group.name.clone().into(),
            None => "New group".into(),
        };
        let open_chat = group.as_ref().map(|group| {
            let group_id = group.id.clone();
            Action::new("open-group-chat", "Open chat")
                .glyph(Glyph::MessageSquare)
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(PanelEvent::OpenGroup {
                        group_id: group_id.clone(),
                    })
                }))
        });

        let bots = match self.bots.value.as_deref() {
            Some([]) => ui::notice("Create a bot first to put it in a group.", None, t),
            Some(bots) => div().flex().flex_col().children(bots.iter().map(|bot| {
                let id = bot.id.clone();
                let on = view.chosen.contains(&bot.id);
                Row::new(
                    SharedString::from(format!("group-bot-{}", bot.id)),
                    bot.name.clone(),
                )
                .leading(ui::bot_face(t.identity_for(&bot.color), 32.))
                .detail(bot.description.clone())
                .trailing(
                    Toggle::new(
                        SharedString::from(format!("group-bot-toggle-{}", bot.id)),
                        bot.name.clone(),
                        on,
                    )
                    .on_change(cx.listener(move |panel, on: &bool, _, cx| {
                        panel.toggle_group_bot(id.clone(), *on, cx)
                    })),
                )
            })),
            None => match &self.bots.failure {
                Some(failure) => ui::notice(failure.sentence("load the bots"), None, t),
                None => ui::loading_line(t),
            },
        };

        let submit = match &group {
            Some(_) => Action::new("save-group", "Save")
                .tone(Tone::Primary)
                .disabled(name_missing || !enough_bots || !view.dirty(cx))
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.save_group(window, cx))),
            None => Action::new("create-group", "Create group")
                .tone(Tone::Primary)
                .disabled(name_missing || !enough_bots)
                .busy(view.saving)
                .on_click(cx.listener(|panel, _, window, cx| panel.create_group(window, cx))),
        };
        let reload = group.as_ref().filter(|_| view.problem.is_some()).map(|_| {
            Action::new("reload-group", "Reload")
                .tone(Tone::Link)
                .on_click(cx.listener(|panel, _, window, cx| panel.reload_group(window, cx)))
        });

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(detail_header(title, back, open_chat, t).pb_0())
            .child(ui::labelled(
                "Name",
                ui::text_field(&view.name, "Name", false, window, cx),
                None,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(ui::group_label("Bots in this group (2 to 10)", t))
                    .child(bots),
            )
            .when_some(view.problem.clone(), |this, problem| {
                this.child(ui::problem_line(problem, t))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(submit)
                    .children(reload),
            )
            .when_some(group, |this, group| {
                this.child(ui::divider(t))
                    .child(ui::setting_row(
                        "Pinned",
                        None,
                        Toggle::new("group-pinned", "Pinned", group.pinned).on_change(cx.listener(
                            |panel, on: &bool, window, cx| panel.set_group_pinned(*on, window, cx),
                        )),
                        t,
                    ))
                    .child(ui::divider(t))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(
                                Action::new("duplicate-group", "Duplicate")
                                    .glyph(Glyph::Copy)
                                    .busy(view.busy == Some("duplicate"))
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        panel.duplicate_group(window, cx)
                                    })),
                            )
                            .child(
                                Action::new("archive-group", "Archive")
                                    .glyph(Glyph::Archive)
                                    .busy(view.busy == Some("archive"))
                                    .on_click(cx.listener(|panel, _, window, cx| {
                                        panel.archive_group(window, cx)
                                    })),
                            ),
                    )
            })
    }
}

fn group_face(group: &Group, t: &Tokens) -> Div {
    ui::group_face(
        group
            .members
            .iter()
            .map(|member| t.identity_for(&member.color)),
        40.,
    )
}
