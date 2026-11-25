use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::card;
use crate::app::{conversation::FileState, Desktop};
use crate::files;
use crate::theme::{radius, Theme};
use crate::transcript::{Entry, FileRef};
use crate::ui::focus::{self, Ring};
use crate::ui::motion::{Colors, Pointer};
use crate::ui::{icon, Type};

pub(super) fn row_id(row: usize, entry: Option<&Entry>) -> ElementId {
    match entry {
        Some(entry) => ElementId::Name(SharedString::from(format!("message:{}", entry.id))),
        None => {
            if row == 0 {
                "chat-head".into()
            } else {
                "chat-tail".into()
            }
        }
    }
}

fn card_id(file: &FileRef, occurrence: usize) -> ElementId {
    (SharedString::from(format!("attachment:{}", file.artifact_id)), occurrence).into()
}

fn file_action<V: 'static>(
    file: &FileRef,
    label: &'static str,
    theme: &Theme,
    fills: Colors,
    cx: &Context<V>,
    click: impl Fn(&mut V, FileRef, &mut Window, &mut Context<V>) + 'static,
) -> focus::FocusControl {
    let file = file.clone();
    let button = div()
        .id(label)
        .h_7()
        .px_2p5()
        .flex()
        .items_center()
        .rounded(radius::MENU_ROW)
        .body()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.accent_text)
        .cursor_pointer()
        .on_click(cx.listener(move |this, _, window, cx| click(this, file.clone(), window, cx)))
        .child(label);
    focus::control(button, Ring::Inner(radius::MENU_ROW), theme).fill(Pointer::BUTTON, fills)
}

impl Desktop {
    pub(super) fn render_file(
        &self,
        file: &FileRef,
        occurrence: usize,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = self.chat.as_ref().and_then(|chat| chat.conversation.files.get(&file.artifact_id));
        let fetching = state == Some(&FileState::Fetching);
        let problem = match state {
            Some(FileState::Problem(problem)) => Some(problem.clone()),
            _ => None,
        };
        let glyph = if files::is_image(&file.mime_type) { "image" } else { "file-text" };
        let kind = file.name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_uppercase());
        let detail: Vec<String> = kind.into_iter().chain(file.size.map(files::size_label)).collect();
        let fills = Colors::ink(theme, 0., 0.06, 0.10);
        let action = |label, open, cx: &mut Context<Self>| {
            file_action(file, label, theme, fills, cx, move |this, file, window, cx| {
                this.fetch_file(file, open, window, cx)
            })
        };
        let actions = if fetching {
            div().px_2().child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary))
        } else {
            div()
                .flex()
                .items_center()
                .when(files::opens_as(&file.mime_type).is_some(), |actions| actions.child(action("Open", true, cx)))
                .child(action("Save", false, cx))
        };
        let card = card(theme)
            .id(card_id(file, occurrence))
            .bg(theme.card)
            .rounded(radius::CARD)
            .w_full()
            .max_w(px(380.))
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .child(
                        div()
                            .size_9()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(radius::FIELD)
                            .bg(theme.ink_at(0.06))
                            .child(icon(glyph, px(16.), theme.ink_secondary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().body().font_weight(FontWeight::MEDIUM).truncate().child(file.name.clone()))
                            .when(!detail.is_empty(), |text| {
                                text.child(div().meta().text_color(theme.ink_tertiary).child(detail.join(" · ")))
                            }),
                    )
                    .child(actions.flex_shrink_0()),
            )
            .children(problem.map(|problem| div().meta().text_color(theme.danger).child(problem)));
        let outline = Colors::ink(theme, 0.08, 0.16, 0.16);
        focus::decorate(card)
            .tint(Pointer::HOVER_ONLY, move |card, levels| card.border_color(outline.sample(levels)))
            .into_any_element()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::fonts::Fonts;
    use crate::theme::Skin;
    use crate::transcript::{prepend, Part, Speaker};

    struct History {
        entries: Vec<Entry>,
        list: ListState,
        saved: Option<String>,
    }

    impl Render for History {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            list(self.list.clone(), cx.processor(|history, index, _, cx| history.row(index, cx))).size_full()
        }
    }

    impl History {
        fn row(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
            let theme = Theme::of(Skin::Midnight, &Fonts { sans: "sans-serif".into(), mono: "monospace".into() });
            let entry = &self.entries[index];
            let Part::File(file) = &entry.parts[0] else { unreachable!() };
            div()
                .id(row_id(index + 1, Some(entry)))
                .child(div().id(card_id(file, 0)).child(file_action(
                    file,
                    "Save",
                    &theme,
                    Colors::ink(&theme, 0., 0.06, 0.10),
                    cx,
                    |history, file, _, _| history.saved = Some(file.artifact_id),
                )))
                .into_any_element()
        }
    }

    fn attachment(id: &str, seq: i64) -> Entry {
        Entry {
            id: id.to_owned(),
            seq,
            speaker: Speaker::Person,
            name: None,
            author_id: None,
            agent_id: None,
            run_id: None,
            local_cli: false,
            at: None,
            quote: None,
            parts: vec![Part::File(FileRef {
                artifact_id: format!("artifact-{id}"),
                name: format!("{id}.txt"),
                mime_type: "text/plain".into(),
                size: None,
            })],
        }
    }

    #[::core::prelude::v1::test]
    fn prepending_an_attachment_preserves_save_focus_and_its_callback() {
        crate::test_support::headless(|cx| {
            let window = cx
                .open_window(WindowOptions::default(), |_, cx| {
                    cx.new(|_| History {
                        entries: vec![attachment("latest", 2)],
                        list: ListState::new(1, ListAlignment::Top, px(100.)),
                        saved: None,
                    })
                })
                .expect("open headless history");
            let handle: AnyWindowHandle = window.into();
            let focused = handle
                .update(cx, |_, window, cx| {
                    window.draw(cx).clear(cx);
                    window.focus_next(cx);
                    window.focused(cx).expect("Save is a tab stop")
                })
                .unwrap();
            window
                .update(cx, |history, _, cx| {
                    let added = prepend(&mut history.entries, vec![attachment("earlier", 1)]);
                    assert_eq!(added, 1);
                    history.list.splice(0..0, added);
                    cx.notify();
                })
                .unwrap();
            handle
                .update(cx, |_, window, cx| {
                    window.draw(cx).clear(cx);
                    assert!(focused.is_focused(window));
                    let key = Keystroke::parse("enter").unwrap();
                    window.dispatch_event(
                        PlatformInput::KeyDown(KeyDownEvent {
                            keystroke: key.clone(),
                            is_held: false,
                            prefer_character_input: false,
                        }),
                        cx,
                    );
                    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: key }), cx);
                })
                .unwrap();
            window.update(cx, |history, _, _| assert_eq!(history.saved.as_deref(), Some("artifact-latest"))).unwrap();
        });
    }
}
