use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::app::onboarding::{Joining, Page};
use crate::app::{Desktop, DialogKind};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{agent_face, error_line, icon, pill_button, Tone, Type};

impl Desktop {
    /// The step shown in place of the workspace, while one is open.
    pub fn render_onboarding(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let page = self.onboarding.page.as_ref()?;
        let body = match page {
            Page::Welcome => self.render_welcome(&theme, cx),
            Page::Join { state, .. } => render_join(state, &theme, cx),
        };
        Some(
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .window_control_area(WindowControlArea::Drag)
                .child(div().w(px(380.)).flex().flex_col().items_center().gap_5().occlude().child(body))
                .into_any_element(),
        )
    }

    fn render_welcome(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let personal = self.space.as_ref().map(|space| space.name.clone()).unwrap_or_default();
        let ink = theme.ink;
        div()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .gap_5()
            .child(heading("Choose a workspace", None, theme))
            .child(
                div()
                    .w_full()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        choice(
                            "welcome-create",
                            "plus",
                            "Create a workspace",
                            "For you and the people you invite",
                            theme,
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.welcome_choice(DialogKind::NewSpace, window, cx)),
                        ),
                    )
                    .child(
                        choice("welcome-join", "link", "Join with an invite", "Use a link someone sent you", theme)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.welcome_choice(DialogKind::JoinSpace, window, cx)
                            })),
                    ),
            )
            .child(
                div()
                    .id("welcome-personal")
                    .body()
                    .text_color(theme.ink_secondary)
                    .cursor_pointer()
                    .hover(move |style| style.text_color(ink))
                    .on_click(cx.listener(|this, _, _, cx| this.leave_onboarding(cx)))
                    .child(format!("Continue in {personal}")),
            )
    }
}

fn render_join(state: &Joining, theme: &Theme, cx: &mut Context<Desktop>) -> Div {
    let page = div().w_full().flex().flex_col().items_center().gap_5();
    let later = || {
        pill_button("join-later", "Not now", Tone::Quiet, true, theme)
            .h_9()
            .w_full()
            .on_click(cx.listener(|this, _, _, cx| this.leave_onboarding(cx)))
    };
    match state {
        Joining::Checking => page.child(heading("Checking your invite…", None, theme)),
        Joining::Ready(preview) | Joining::Accepting(preview) => {
            let accepting = matches!(state, Joining::Accepting(_));
            page.child(heading(
                &format!("Join {}", preview.space_name),
                Some(format!("{} invited you", preview.inviter_name)),
                theme,
            ))
            .child(
                div()
                    .w_full()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        pill_button(
                            "join",
                            if accepting { "Joining…" } else { "Join" },
                            Tone::Primary,
                            !accepting,
                            theme,
                        )
                        .h_9()
                        .w_full()
                        .when(!accepting, |join| {
                            join.on_click(cx.listener(|this, _, window, cx| this.accept_invite(window, cx)))
                        }),
                    )
                    .when(!accepting, |actions| actions.child(later())),
            )
        }
        Joining::Invalid => page.child(heading("This invite link is no longer valid.", None, theme)).child(
            pill_button("join-continue", "Continue", Tone::Primary, true, theme)
                .h_9()
                .w_full()
                .on_click(cx.listener(|this, _, _, cx| this.leave_onboarding(cx))),
        ),
        Joining::Failed(problem) => page.child(heading("Couldn't check your invite", None, theme)).child(
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap_2()
                .child(error_line(problem.clone(), theme))
                .child(
                    pill_button("join-retry", "Try again", Tone::Primary, true, theme)
                        .h_9()
                        .w_full()
                        .on_click(cx.listener(|this, _, window, cx| this.retry_invite(window, cx))),
                )
                .child(later()),
        ),
    }
}

fn heading(title: &str, line: Option<String>, theme: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .items_center()
        .gap_3()
        .child(agent_face(theme.identity_for("blue"), px(56.)))
        .child(div().title().text_center().child(title.to_owned()))
        .children(line.map(|line| div().mt(px(-6.)).item().text_color(theme.ink_secondary).child(line)))
}

/// One of the welcome screen's choices: what it does, and for whom.
fn choice(id: &'static str, glyph: &str, label: &'static str, detail: &'static str, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised_hover;
    div()
        .id(id)
        .w_full()
        .px_4()
        .py_3()
        .flex()
        .items_center()
        .gap_3()
        .rounded(radius::CARD)
        .bg(theme.raised)
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(
            div()
                .size_9()
                .flex_shrink_0()
                .rounded_full()
                .bg(theme.control)
                .flex()
                .items_center()
                .justify_center()
                .child(icon(glyph, px(16.), theme.ink)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().name().child(label))
                .child(div().body().text_color(theme.ink_secondary).child(detail)),
        )
}
