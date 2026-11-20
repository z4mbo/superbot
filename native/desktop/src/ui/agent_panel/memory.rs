use superbot_features::{memory_notes, with_memory_note, without_memory_note, MemoryDocument, MemoryNote};

use super::knowledge::{
    conflict_notice, divided, is_conflict, link_row, note_row, page_card, trash_button, Load, Page,
};
use super::*;

/// The agent's memory page. Every write names the revision it was read at, so a note the agent
/// wrote meanwhile is refused as a conflict instead of being lost.
pub(super) struct MemoryPage {
    add: Entity<InputState>,
    _add_events: Subscription,
    text: Option<MemoryText>,
    busy: bool,
    problem: Option<String>,
}

/// One memory document open as text.
struct MemoryText {
    document: MemoryDocument,
    editor: Entity<TextareaState>,
    /// The server's newer version, after a save was refused.
    conflict: Option<MemoryDocument>,
    /// What was typed before a reload replaced it.
    kept: Option<String>,
    confirm_delete: bool,
    _watch: Subscription,
}

impl MemoryPage {
    pub(super) fn new(name: &str, window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        let placeholder = format!("Tell {name} something to remember");
        let add = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        let events = cx.subscribe_in(&add, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.add_memory_note(window, cx);
            }
        });
        Self { add, _add_events: events, text: None, busy: false, problem: None }
    }

    /// Escape inside the page: closes the open document first.
    pub(super) fn back(&mut self) -> bool {
        self.text.take().is_some()
    }
}

const CONFLICT: &str = "This file changed while you were editing.";

impl Desktop {
    fn memory_page(&mut self) -> Option<&mut MemoryPage> {
        match self.agent_panel.as_mut()?.page.as_mut()? {
            Page::Memory(page) => Some(page),
            _ => None,
        }
    }

    fn memory_docs(&self) -> Option<&Vec<MemoryDocument>> {
        self.agent_panel.as_ref()?.knowledge.memory.as_ref()?.ready()
    }

    /// Takes in what a write confirmed at once, then re-reads the memory and its budget.
    fn memory_saved(
        &mut self,
        document: Option<MemoryDocument>,
        removed: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(panel) = self.agent_panel.as_mut() {
            if let Some(Load::Ready(docs)) = panel.knowledge.memory.as_mut() {
                if let Some(document) = document {
                    match docs.iter_mut().find(|doc| doc.id == document.id) {
                        Some(doc) => *doc = document,
                        None => docs.push(document),
                    }
                }
                if let Some(id) = removed {
                    docs.retain(|doc| doc.id != id);
                }
            }
            panel.knowledge.stale();
        }
        self.sync_agent_info(window, cx);
    }

    fn memory_failed(&mut self, error: &Error, window: &mut Window, cx: &mut Context<Self>) {
        let problem = if is_conflict(error) { CONFLICT.to_owned() } else { api::explain(error) };
        if let Some(page) = self.memory_page() {
            page.problem = Some(problem);
        }
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.knowledge.stale();
        }
        self.sync_agent_info(window, cx);
    }

    fn write_memory(
        &mut self,
        document: &MemoryDocument,
        content: String,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let Some((features, space)) = self.features() else { return };
        let Some(page) = self.memory_page().filter(|page| !page.busy) else { return };
        page.busy = true;
        page.problem = None;
        let (id, revision) = (document.id.clone(), document.revision);
        let work = async move { features.space(space).update_memory(&id, &content, Some(revision)).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            if let Some(page) = this.memory_page() {
                page.busy = false;
            }
            match result {
                Ok(saved) => {
                    this.memory_saved(Some(saved), None, window, cx);
                    then(this, window, cx);
                }
                Err(error) => this.memory_failed(&error, window, cx),
            }
        });
        cx.notify();
    }

    fn add_memory_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.memory_page() else { return };
        let note = page.add.read(cx).value().trim().to_owned();
        if note.is_empty() {
            return;
        }
        let Some(index) = self.memory_docs().and_then(|docs| docs.iter().find(|doc| doc.is_index())).cloned() else {
            return;
        };
        let content = with_memory_note(&index.content, &note);
        self.write_memory(&index, content, window, cx, |this, window, cx| {
            if let Some(page) = this.memory_page() {
                let add = page.add.clone();
                add.update(cx, |state, cx| state.set_value("", window, cx));
            }
        });
    }

    fn forget_memory_note(&mut self, note: MemoryNote, window: &mut Window, cx: &mut Context<Self>) {
        let Some(document) =
            self.memory_docs().and_then(|docs| docs.iter().find(|doc| doc.id == note.document_id)).cloned()
        else {
            return;
        };
        match note.line {
            Some(_) => match without_memory_note(&document.content, &note) {
                Some(content) => self.write_memory(&document, content, window, cx, |_, _, _| {}),
                None => {
                    if let Some(page) = self.memory_page() {
                        page.problem = Some(CONFLICT.to_owned());
                    }
                    cx.notify();
                }
            },
            None => self.remove_memory_document(document, window, cx),
        }
    }

    fn remove_memory_document(&mut self, document: MemoryDocument, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(page) = self.memory_page().filter(|page| !page.busy) else { return };
        page.busy = true;
        page.problem = None;
        let id = document.id.clone();
        let work = async move { features.space(space).remove_memory(&id).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            if let Some(page) = this.memory_page() {
                page.busy = false;
            }
            match result {
                Ok(()) => {
                    if let Some(page) = this.memory_page() {
                        page.text = None;
                    }
                    this.memory_saved(None, Some(&document.id), window, cx);
                }
                Err(error) => this.memory_failed(&error, window, cx),
            }
        });
        cx.notify();
    }

    fn open_memory_text(&mut self, document: MemoryDocument, window: &mut Window, cx: &mut Context<Self>) {
        let content = document.content.clone();
        let editor = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(10, 24)
                .placeholder("Nothing remembered yet. The agent writes durable notes here, or add your own.")
                .default_value(content)
        });
        editor.update(cx, |state, cx| {
            let end = state.value().len();
            state.set_selected_range(end..end, cx);
            state.focus(window, cx);
        });
        let watch = cx.observe(&editor, |_, _, cx| cx.notify());
        if let Some(page) = self.memory_page() {
            page.problem = None;
            page.text =
                Some(MemoryText { document, editor, conflict: None, kept: None, confirm_delete: false, _watch: watch });
        }
        cx.notify();
    }

    fn save_memory_text(&mut self, overwrite: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let Some(page_bot) = self.agent_panel.as_ref().map(|panel| panel.agent_id.clone()) else { return };
        let Some(page) = self.memory_page().filter(|page| !page.busy) else { return };
        let Some(text) = page.text.as_ref() else { return };
        let content = text.editor.read(cx).value().to_string();
        let base = if overwrite { text.conflict.as_ref().unwrap_or(&text.document) } else { &text.document };
        let (id, revision, bot_id) = (base.id.clone(), base.revision, page_bot);
        page.busy = true;
        page.problem = None;
        let work = async move {
            let space = features.space(space);
            match space.update_memory(&id, &content, Some(revision)).await {
                Ok(saved) => Ok(Ok(saved)),
                Err(error) if is_conflict(&error) => {
                    let latest = space.bot_memory(&bot_id).await?.into_iter().find(|doc| doc.id == id);
                    Ok(Err(latest))
                }
                Err(error) => Err(error),
            }
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(page) = this.memory_page() else { return };
            page.busy = false;
            match result {
                Ok(Ok(saved)) => {
                    page.text = None;
                    this.memory_saved(Some(saved), None, window, cx);
                }
                Ok(Err(Some(latest))) => {
                    if let Some(text) = page.text.as_mut() {
                        text.conflict = Some(latest);
                    }
                }
                Ok(Err(None)) => page.problem = Some("This file was deleted while you were editing.".into()),
                Err(error) => page.problem = Some(api::explain(&error)),
            }
        });
        cx.notify();
    }

    /// Shows the agent's version and keeps what was typed beside it, so nothing is lost.
    fn reload_memory_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.memory_page().and_then(|page| page.text.as_mut()) else { return };
        let Some(latest) = text.conflict.take() else { return };
        let typed = text.editor.read(cx).value().to_string();
        text.kept = Some(match text.kept.take() {
            Some(kept) if kept != typed => format!("{kept}\n\n{typed}"),
            _ => typed,
        });
        let editor = text.editor.clone();
        let content = latest.content.clone();
        text.document = latest;
        editor.update(cx, |state, cx| state.set_value(content, window, cx));
        cx.notify();
    }

    pub(super) fn render_memory_page(
        &self,
        bot: &Bot,
        page: &MemoryPage,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        if let Some(text) = page.text.as_ref() {
            return self.render_memory_text(bot, page, text, theme, cx);
        }
        let knowledge = self.agent_panel.as_ref().map(|panel| &panel.knowledge);
        let memory = knowledge.and_then(|knowledge| knowledge.memory.as_ref());
        let docs = memory.and_then(Load::ready);
        let left_out = knowledge
            .and_then(|knowledge| knowledge.budget.as_ref())
            .map(|budget| budget.bytes_left_out())
            .filter(|bytes| *bytes > 0);

        let mut notes_card = page_card(theme);
        match memory {
            None | Some(Load::Loading) => notes_card = notes_card.child(note_row("Checking…", false, theme)),
            Some(Load::Failed(_)) => {
                notes_card = notes_card.child(note_row("Couldn't read the memory just now.", true, theme)).child(
                    divided(link_row("memory-retry", "Try again", "rotate-cw", theme), 1, theme).on_click(cx.listener(
                        |this, _, window, cx| {
                            if let Some(panel) = this.agent_panel.as_mut() {
                                panel.knowledge.stale();
                                panel.knowledge.memory = None;
                            }
                            this.sync_agent_info(window, cx);
                            cx.notify();
                        },
                    )),
                )
            }
            Some(Load::Ready(docs)) => {
                let notes = memory_notes(docs);
                if notes.is_empty() {
                    notes_card = notes_card.child(note_row("Nothing remembered yet.", false, theme));
                }
                for (index, note) in notes.into_iter().enumerate() {
                    let id = SharedString::from(format!(
                        "memory-note-{}-{}",
                        note.document_id,
                        note.line.unwrap_or(usize::MAX)
                    ));
                    let text = note.text.clone();
                    let forget =
                        trash_button(SharedString::from(format!("{id}-forget")), !page.busy, theme)
                            .map(|button| tooltip::on(button, "Forget"))
                            .when(!page.busy, |button| {
                                button.on_click(cx.listener(move |this, _, window, cx| {
                                    this.forget_memory_note(note.clone(), window, cx)
                                }))
                            });
                    notes_card = notes_card.child(divided(
                        div()
                            .id(id)
                            .flex()
                            .items_start()
                            .gap(px(10.))
                            .px(px(14.))
                            .py(px(9.))
                            .child(div().flex_1().min_w_0().pt(px(4.)).body().text_color(theme.ink).child(text))
                            .child(forget),
                        index,
                        theme,
                    ));
                }
            }
        }
        if let Some(bytes) = left_out {
            let kb = bytes.div_ceil(1024);
            notes_card = notes_card.child(divided(
                note_row(format!("About {kb} KB of memory no longer reaches {}.", bot.name), true, theme),
                1,
                theme,
            ));
        }
        if let Some(problem) = page.problem.clone() {
            notes_card = notes_card.child(divided(note_row(problem, true, theme), 1, theme));
        }

        let index = docs.and_then(|docs| docs.iter().find(|doc| doc.is_index())).cloned();
        let can_add = index.is_some() && !page.busy;
        let add_card = page_card(theme)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(14.))
                    .py(px(9.))
                    .child(
                        crate::ui::field_box(theme)
                            .flex_1()
                            .min_w_0()
                            .child(Input::new(&page.add).appearance(false).bordered(false).small().disabled(!can_add)),
                    )
                    .child(
                        crate::ui::pill_button("memory-add", "Add", crate::ui::Tone::Quiet, can_add, theme).when(
                            can_add,
                            |button| {
                                button.on_click(cx.listener(|this, _, window, cx| this.add_memory_note(window, cx)))
                            },
                        ),
                    ),
            )
            .children(index.map(|index| {
                divided(link_row("memory-edit-text", "Edit as text", "file-text", theme), 1, theme)
                    .on_click(cx.listener(move |this, _, window, cx| this.open_memory_text(index.clone(), window, cx)))
            }));

        let files: Vec<MemoryDocument> =
            docs.map(|docs| docs.iter().filter(|doc| !doc.is_index()).cloned().collect()).unwrap_or_default();
        let hover = theme.ink_at(0.03);
        let files_card = (!files.is_empty()).then(|| {
            div().child(card_label("Files", theme)).child(card(theme).children(files.into_iter().enumerate().map(
                |(index, document)| {
                    let path = document.path.clone();
                    divided(
                        div()
                            .id(SharedString::from(format!("memory-file-{}", document.id)))
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .min_h(px(46.))
                            .px(px(14.))
                            .cursor_pointer()
                            .hover(move |style| style.bg(hover))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_memory_text(document.clone(), window, cx)
                            }))
                            .child(icon("file-text", px(16.), theme.ink_secondary))
                            .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(path))
                            .child(icon("chevron-right", px(15.), theme.ink_tertiary)),
                        index,
                        theme,
                    )
                },
            )))
        });

        div().flex().flex_col().child(notes_card).child(add_card).children(files_card)
    }

    fn render_memory_text(
        &self,
        bot: &Bot,
        page: &MemoryPage,
        text: &MemoryText,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let busy = page.busy;
        let conflict = text.conflict.as_ref().map(|_| {
            conflict_notice(
                CONFLICT,
                "Nothing has been saved. Reload to see the latest version, or overwrite it with yours.",
                theme,
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        crate::ui::pill_button("memory-reload", "Reload", crate::ui::Tone::Quiet, !busy, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.reload_memory_text(window, cx))),
                    )
                    .child(
                        crate::ui::pill_button("memory-overwrite", "Overwrite", crate::ui::Tone::Danger, !busy, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.save_memory_text(true, window, cx))),
                    ),
            )
        });
        let kept = text.kept.clone().map(|kept| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div().meta().text_color(theme.ink_secondary).child("Your unsaved draft, kept so nothing is lost:"),
                )
                .child(
                    div()
                        .max_h(px(160.))
                        .p_3()
                        .rounded(radius::FIELD)
                        .bg(theme.inset)
                        .border_1()
                        .border_color(theme.hairline.opacity(0.4))
                        .font_family(theme.mono.clone())
                        .meta()
                        .text_color(theme.ink)
                        .child(kept),
                )
                .child(
                    div().flex().child(
                        crate::ui::pill_button(
                            "memory-dismiss-draft",
                            "Dismiss draft",
                            crate::ui::Tone::Quiet,
                            true,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(text) = this.memory_page().and_then(|page| page.text.as_mut()) {
                                text.kept = None;
                            }
                            cx.notify();
                        })),
                    ),
                )
        });
        let unchanged = text.editor.read(cx).value().as_ref() == text.document.content.as_str();
        let can_save = !busy && text.conflict.is_none() && !unchanged;
        let delete = text.document.deletable().then(|| {
            let confirm = text.confirm_delete;
            crate::ui::pill_button(
                "memory-delete",
                if confirm { "Confirm delete" } else { "Delete" },
                crate::ui::Tone::Danger,
                !busy,
                theme,
            )
            .when(!busy, |button| {
                button.on_click(cx.listener(move |this, _, window, cx| {
                    let Some(text) = this.memory_page().and_then(|page| page.text.as_mut()) else { return };
                    if !text.confirm_delete {
                        text.confirm_delete = true;
                        cx.notify();
                        return;
                    }
                    let document = text.document.clone();
                    this.remove_memory_document(document, window, cx);
                }))
            })
        });
        page_card(theme).child(
            div()
                .flex()
                .flex_col()
                .gap(px(9.))
                .px(px(14.))
                .py(px(11.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(icon("file-text", px(16.), theme.ink_secondary))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .name()
                                .text_color(theme.ink)
                                .truncate()
                                .child(text.document.path.clone()),
                        ),
                )
                .children(conflict)
                .child(
                    crate::ui::field_box(theme).items_start().py_1().font_family(theme.mono.clone()).child(
                        Textarea::new(&text.editor)
                            .appearance(false)
                            .bordered(false)
                            .readonly(busy)
                            .aria_label(SharedString::from(format!("{} memory", bot.name))),
                    ),
                )
                .children(page.problem.clone().map(|problem| div().body().text_color(theme.warning).child(problem)))
                .children(kept)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .children(delete)
                        .child(div().flex_1())
                        .child(
                            crate::ui::pill_button(
                                "memory-text-cancel",
                                "Cancel",
                                crate::ui::Tone::Quiet,
                                !busy,
                                theme,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(page) = this.memory_page() {
                                    page.text = None;
                                    page.problem = None;
                                }
                                cx.notify();
                            })),
                        )
                        .child(
                            crate::ui::pill_button(
                                "memory-text-save",
                                if busy { "Saving…" } else { "Save" },
                                crate::ui::Tone::Primary,
                                can_save,
                                theme,
                            )
                            .when(can_save, |button| {
                                button.on_click(
                                    cx.listener(|this, _, window, cx| this.save_memory_text(false, window, cx)),
                                )
                            }),
                        ),
                ),
        )
    }
}
