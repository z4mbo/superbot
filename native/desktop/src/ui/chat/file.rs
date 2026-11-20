use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::card;
use crate::app::{conversation::FileState, Desktop};
use crate::files;
use crate::theme::{radius, Theme};
use crate::transcript::FileRef;
use crate::ui::{icon, Type};

impl Desktop {
    pub(super) fn render_file(
        &self,
        file: &FileRef,
        key: (usize, usize),
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
        let hover = theme.ink_at(0.06);
        let action = |label: &'static str, open: bool, cx: &mut Context<Self>| {
            let file = file.clone();
            div()
                .id((label, key.0 * 64 + key.1))
                .h_7()
                .px_2p5()
                .flex()
                .items_center()
                .rounded_full()
                .body()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.accent_text)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(cx.listener(move |this, _, window, cx| this.fetch_file(file.clone(), open, window, cx)))
                .child(label)
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
        card(theme)
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
            .children(problem.map(|problem| div().meta().text_color(theme.danger).child(problem)))
            .into_any_element()
    }
}
