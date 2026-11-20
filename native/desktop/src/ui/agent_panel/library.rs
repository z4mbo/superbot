use superbot_features::{LibraryItem, LibraryKind};

use super::*;
use crate::clock;
use crate::transcript::FileRef;

/// What the open conversation made: its pages, files and apps, as the server lists them for it.
/// Nothing from elsewhere in the Space is shown here.
pub(super) enum LibraryView {
    Loading,
    Ready(Vec<LibraryItem>),
    Failed(String),
}

impl Desktop {
    pub(super) fn read_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.chat.as_ref().map(|chat| chat.target.clone()) else { return };
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        panel.library = Some((target.clone(), LibraryView::Loading));
        let read = target.clone();
        let work = async move { features.space(space).conversation_library(read.wire()).await };
        self.call(window, cx, work, move |this, result, _, _| {
            let Some(panel) = this.agent_panel.as_mut() else { return };
            if panel.library.as_ref().map(|(at, _)| at) != Some(&target) {
                return;
            }
            panel.library = Some((
                target,
                match result {
                    Ok(items) => LibraryView::Ready(items),
                    Err(error) => LibraryView::Failed(api::explain(&error)),
                },
            ));
        });
    }

    /// A page or app is drawn by the web client, so it opens there, on its conversation.
    fn open_library_on_web(&mut self, item: &LibraryItem, cx: &mut Context<Self>) {
        let Some(mut url) = self.web_workspace_url().and_then(|url| url::Url::parse(&url).ok()) else { return };
        match item.kind {
            LibraryKind::Page => {
                url.query_pairs_mut().append_pair("page", &item.id);
            }
            LibraryKind::App => {
                if let Some(message) = item.message_id.as_deref() {
                    url.query_pairs_mut().append_pair("m", message);
                }
            }
            LibraryKind::Artifact => return,
        }
        self.open_web_url(url.into(), cx);
    }

    fn library_file(item: &LibraryItem) -> FileRef {
        FileRef {
            artifact_id: item.id.clone(),
            name: item.title.clone(),
            mime_type: item.mime_type.clone().unwrap_or_else(|| "application/octet-stream".into()),
            size: None,
        }
    }

    fn library_author(&self, item: &LibraryItem) -> Option<String> {
        if let Some(bot) = item.author_bot_id.as_deref() {
            return self.agent(bot).map(|agent| agent.name.clone());
        }
        let me = self.me.as_ref()?;
        (item.author_user_id.as_deref() == Some(me.user_id.as_str())).then(|| "You".to_owned())
    }

    pub(super) fn render_library(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let target = self.chat.as_ref().map(|chat| chat.target.clone());
        let view = self
            .agent_panel
            .as_ref()
            .and_then(|panel| panel.library.as_ref())
            .filter(|(at, _)| Some(at) == target.as_ref())
            .map(|(_, view)| view);
        let items = match view {
            None | Some(LibraryView::Loading) => {
                return div()
                    .pt_10()
                    .flex()
                    .justify_center()
                    .child(Spinner::new().with_size(px(16.)).color(theme.ink_tertiary))
                    .into_any_element()
            }
            Some(LibraryView::Failed(problem)) => {
                return div()
                    .pt_3()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(error_line(problem.clone(), theme))
                    .child(
                        crate::ui::pill_button("library-retry", "Try again", crate::ui::Tone::Quiet, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.read_library(window, cx))),
                    )
                    .into_any_element()
            }
            Some(LibraryView::Ready(items)) => items,
        };
        if items.is_empty() {
            return div()
                .px_3()
                .py(px(28.))
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_tertiary)
                .child("Pages, files, and apps this agent makes show up here")
                .into_any_element();
        }
        let now = clock::now();
        let section = |kind: LibraryKind, label: &'static str, glyph: &'static str, cx: &mut Context<Self>| {
            let rows: Vec<&LibraryItem> = items.iter().filter(|item| item.kind == kind).collect();
            (!rows.is_empty()).then(|| {
                div().child(card_label(label, theme)).child(
                    card(theme).children(
                        rows.into_iter()
                            .enumerate()
                            .map(|(index, item)| self.render_library_row(item, index, glyph, now, theme, cx)),
                    ),
                )
            })
        };
        div()
            .flex()
            .flex_col()
            .children(section(LibraryKind::Page, "Pages", "globe", cx))
            .children(section(LibraryKind::App, "Apps", "app-window", cx))
            .children(section(LibraryKind::Artifact, "Files", "file-text", cx))
            .child(
                div()
                    .mt_3()
                    .flex()
                    .justify_center()
                    .meta()
                    .text_color(theme.ink_tertiary)
                    .child("From this conversation"),
            )
            .into_any_element()
    }

    fn render_library_row(
        &self,
        item: &LibraryItem,
        index: usize,
        glyph: &'static str,
        now: clock::Instant,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover = theme.ink_at(0.03);
        let fetching = matches!(
            self.chat.as_ref().and_then(|chat| chat.conversation.files.get(&item.id)),
            Some(crate::app::conversation::FileState::Fetching)
        );
        let problem = match self.chat.as_ref().and_then(|chat| chat.conversation.files.get(&item.id)) {
            Some(crate::app::conversation::FileState::Problem(problem)) => Some(problem.clone()),
            _ => None,
        };
        let hint = [
            self.library_author(item),
            clock::instant(&item.created_at).map(|at| clock::stamp(at, now, &chrono::Local)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let open_item = item.clone();
        let file = item.kind == LibraryKind::Artifact;
        let save = file.then(|| {
            let file = Self::library_file(item);
            let hover = theme.ink_at(0.07);
            div()
                .id(SharedString::from(format!("library-save-{}", item.id)))
                .size_7()
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .hover(move |style| style.bg(hover))
                .tooltip(|window, cx| Tooltip::new("Download").build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.fetch_file(file.clone(), false, window, cx);
                }))
                .child(icon("download", px(15.), theme.ink_secondary))
        });
        div()
            .id(SharedString::from(format!("library-{}", item.id)))
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .py(px(8.))
            .when(index > 0, |row| row.border_t_1().border_color(theme.ink_at(0.05)))
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                if open_item.kind == LibraryKind::Artifact {
                    this.fetch_file(Self::library_file(&open_item), true, window, cx);
                } else {
                    this.open_library_on_web(&open_item, cx);
                }
            }))
            .child(icon(glyph, px(16.), theme.ink_secondary))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().name().text_color(theme.ink).truncate().child(item.title.clone()))
                    .children(match problem {
                        Some(problem) => {
                            Some(div().mt(px(1.)).body().text_color(theme.danger).truncate().child(problem))
                        }
                        None => (!hint.is_empty())
                            .then(|| div().mt(px(1.)).body().text_color(theme.ink_secondary).truncate().child(hint)),
                    }),
            )
            .when(fetching, |row| row.child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary)))
            .children(save.filter(|_| !fetching))
            .when(!file, |row| row.child(icon("external-link", px(14.), theme.ink_tertiary)))
            .into_any_element()
    }

    pub(super) fn render_agent_inbox(&self, bot: &Bot, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let rows = self.inbox.of_agent(&bot.id);
        if rows.is_empty() {
            return div()
                .px_3()
                .py(px(28.))
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_tertiary)
                .child(if self.inbox.has_read() { "Nothing for you yet." } else { "" })
                .into_any_element();
        }
        let now = clock::now();
        div()
            .flex()
            .flex_col()
            .gap_0p5()
            .children(rows.into_iter().map(|item| self.render_inbox_row(item, now, theme, cx)))
            .into_any_element()
    }
}
