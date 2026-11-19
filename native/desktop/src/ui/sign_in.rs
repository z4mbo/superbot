use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::app::{Desktop, SignInMode};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{agent_face, error_line, field, pill_button, Tone, Type};

impl Desktop {
    pub fn render_sign_in(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let form = &self.sign_in;
        let (title, action, working) = match form.mode {
            SignInMode::Password => ("Sign in", "Sign in", "Signing in…"),
            SignInMode::CreateAccount => ("Create your account", "Create account", "Creating account…"),
            SignInMode::Code => ("Enter your code", "Sign in", "Signing in…"),
        };

        let fields = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(form.mode == SignInMode::CreateAccount, |fields| fields.child(field("Name", &form.name, &theme)))
            .child(field("Email", &form.email, &theme))
            .map(|fields| match form.mode {
                SignInMode::Code => fields.child(field("Code", &form.code, &theme)),
                _ => fields.child(field("Password", &form.password, &theme)),
            })
            .child(field("Server", &form.server, &theme));

        let switches = match form.mode {
            SignInMode::Password => vec![
                ("to-code", "Email me a code instead", Switch::RequestCode),
                ("to-create", "Create an account", Switch::Mode(SignInMode::CreateAccount)),
            ],
            SignInMode::CreateAccount => {
                vec![("to-sign-in", "I already have an account", Switch::Mode(SignInMode::Password))]
            }
            SignInMode::Code => vec![
                ("resend", "Send a new code", Switch::RequestCode),
                ("to-password", "Use a password instead", Switch::Mode(SignInMode::Password)),
            ],
        };

        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .w(px(360.))
                    .flex()
                    .flex_col()
                    .gap_5()
                    .occlude()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap_3()
                            .child(agent_face(theme.identity_for("blue"), px(56.)))
                            .child(div().title().child(title)),
                    )
                    .children(form.error.clone().map(|error| error_line(error, &theme)))
                    .children(form.status.clone().map(|status| status_line(status, &theme)))
                    .child(fields)
                    .child(
                        pill_button(
                            "submit-sign-in",
                            if form.busy { working } else { action },
                            Tone::Primary,
                            !form.busy,
                            &theme,
                        )
                        .h_9()
                        .w_full()
                        .on_click(cx.listener(|this, _, window, cx| this.submit_sign_in(window, cx))),
                    )
                    .child(div().flex().flex_col().items_center().gap_2().children(switches.into_iter().map(
                        |(id, label, switch)| {
                            let ink = theme.ink;
                            div()
                                .id(id)
                                .body()
                                .text_color(theme.ink_secondary)
                                .cursor_pointer()
                                .hover(move |style| style.text_color(ink))
                                .on_click(cx.listener(move |this, _, window, cx| match switch {
                                    Switch::Mode(mode) => this.set_sign_in_mode(mode, cx),
                                    Switch::RequestCode => this.request_code(window, cx),
                                }))
                                .child(label)
                        },
                    ))),
            )
            .into_any_element()
    }

    pub fn render_restoring(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin();
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .window_control_area(WindowControlArea::Drag)
            .child(agent_face(theme.identity_for("blue"), px(56.)))
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum Switch {
    Mode(SignInMode),
    RequestCode,
}

fn status_line(text: String, theme: &Theme) -> Div {
    div().px_3().py_2().rounded(radius::CARD).bg(theme.ink_at(0.05)).body().text_color(theme.ink_secondary).child(text)
}
