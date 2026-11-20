use gpui_kit::component::input::{Enter, Escape, IndentInline, MoveDown, MoveUp, Textarea};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_workspace_panel::Section;

use crate::api::Target;
use crate::app::Desktop;
use crate::files;
use crate::outbox::Attachment;
use crate::theme::{radius, Theme, CHAT_COLUMN};
use crate::ui::focus::{self, Ring};
use crate::ui::motion::{Colors, Pointer};
use crate::ui::{error_line, icon, pill_button, Tone, Type};

/// The composer's lift, in CSS `box-shadow` terms.
fn composer_shadow() -> Vec<BoxShadow> {
    // GPUI (gpui-pre 0.3.12) takes `blur_radius` as the Gaussian sigma; CSS blur is twice it.
    let shadow = |alpha: f32, y: f32, blur: f32, spread: f32| BoxShadow {
        color: hsla(0., 0., 0., alpha),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur / 2.),
        spread_radius: px(spread),
        inset: false,
    };
    vec![
        shadow(0.05, 2., 8., -1.),
        shadow(0.03, 1., 2., 0.),
        BoxShadow { color: rgba(0xe4e4e40a).into(), ..shadow(0., 0., 0., 1.) },
    ]
}

fn attach_control(button: Stateful<Div>, enabled: bool, theme: &Theme) -> AnyElement {
    if !enabled {
        return button.into_any_element();
    }
    let fill = Colors::ink(theme, 0.04, 0.08, 0.12);
    let glyph = Colors::new(theme.ink_tertiary, theme.ink_secondary, theme.ink_secondary);
    focus::control(button, Ring::OuterPill, theme)
        .tint(Pointer::BUTTON, move |button, levels| {
            button.bg(fill.sample(levels)).child(icon("composer-plus", px(20.), glyph.sample(levels)))
        })
        .into_any_element()
}

fn send_control(button: Stateful<Div>, enabled: bool, fill: Hsla, ink: Hsla, theme: &Theme) -> AnyElement {
    if !enabled {
        return button.into_any_element();
    }
    let away = |amount: f32| -> Hsla {
        let (fill, ink) = (fill.to_rgb(), ink.to_rgb());
        let channel = |fill: f32, ink: f32| (fill + (fill - ink) * amount).clamp(0., 1.);
        Rgba { r: channel(fill.r, ink.r), g: channel(fill.g, ink.g), b: channel(fill.b, ink.b), a: fill.a }.into()
    };
    focus::control(button, Ring::OuterPill, theme)
        .fill(Pointer::BUTTON, Colors::new(fill, away(0.12), away(0.22)))
        .into_any_element()
}

fn hover_ring(pill: Stateful<Div>, focused: bool, rest: Hsla, hovered: Hsla) -> focus::FocusControl {
    let outline = Colors::new(rest, hovered, hovered);
    focus::decorate(pill).tint(Pointer::HOVER_ONLY, move |pill, levels| {
        pill.border_color(if focused { hovered } else { outline.sample(levels) })
    })
}

impl Desktop {
    pub(super) fn render_composer(
        &mut self,
        target: &Target,
        theme: &Theme,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Div {
        if let Some(archived) = self.render_archived_composer(theme, cx) {
            return archived;
        }
        let chat = self.chat.as_ref();
        let local = self.selected_local_model();
        let running_local = chat.is_some_and(|chat| chat.local_turn.is_some());
        let working = chat.is_some_and(|chat| chat.working) || running_local;
        let pending = self.pending_local_write();
        let loading = chat.is_some_and(|chat| chat.loading);
        let outbox = chat.map(|chat| &chat.conversation.outbox);
        let sending = outbox.is_some_and(|outbox| outbox.sending) || pending.is_some_and(|write| write.saving);
        let attachments: Vec<Attachment> = outbox.map(|outbox| outbox.attachments.clone()).unwrap_or_default();
        let problem = if local.is_some() && !attachments.is_empty() {
            Some("Remove attachments to send with the local model.".to_owned())
        } else {
            outbox.and_then(|outbox| outbox.problem.clone())
        };
        let editor = self.composer.read(cx);
        let focused = editor.focus_handle(cx).is_focused(window);
        let text = editor.value();
        let has_text = !text.trim().is_empty();
        let multiline = text.contains('\n');
        let needs_model = local.is_none() && self.me.as_ref().is_some_and(|me| me.needs_model);
        let tone = self.chat_tone(theme, cx);
        let identity = match target {
            Target::Agent(id) | Target::Conversation { agent: id, .. } => {
                theme.identity_paint(self.agent(id).map_or("", |agent| agent.color.as_str()))
            }
            Target::Group(_) => (theme.ink, theme.app),
        };
        let has_content = has_text || !attachments.is_empty();
        let stopping = (running_local || working && !has_content) && !sending;
        let ready = has_content
            && pending.is_none()
            && !sending
            && !loading
            && !running_local
            && (local.is_none() || attachments.is_empty());
        let write_problem = pending.and_then(|write| write.problem.clone());
        let (fill, ink) =
            if let (true, Target::Agent(_) | Target::Conversation { .. }, Some(tone)) = (stopping, target, tone) {
                (tone.fill, tone.fill_ink)
            } else if stopping {
                (theme.ink, theme.app)
            } else if has_content {
                match (target, tone) {
                    (Target::Agent(_) | Target::Conversation { .. }, Some(tone)) => (tone.fill, tone.fill_ink),
                    _ => identity,
                }
            } else {
                (theme.raised_hover, theme.ink_secondary)
            };
        let ring = theme.ink_at(0.1);
        let ring_hover = theme.ink_at(0.22);
        let quiet_hover = theme.ink_at(0.08);
        let mentions = self.mention_list(cx);

        let has_attachments = !attachments.is_empty();
        let tray = has_attachments.then(|| {
            div().flex().flex_wrap().gap_2().children(attachments.iter().map(|attached| {
                let id = attached.id;
                let glyph = if files::is_image(attached.mime_type) { "image" } else { "file-text" };
                let detail = if sending { "Sending…".to_owned() } else { files::size_label(attached.size) };
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .h(px(44.))
                    .pl_2p5()
                    .pr_1p5()
                    .rounded(radius::CARD)
                    .bg(theme.control)
                    .child(icon(glyph, px(16.), theme.ink_secondary))
                    .child(
                        div()
                            .max_w(px(200.))
                            .flex()
                            .flex_col()
                            .child(div().meta().font_weight(FontWeight::MEDIUM).truncate().child(attached.name.clone()))
                            .child(div().meta().text_color(theme.ink_tertiary).child(detail)),
                    )
                    .when(!sending, |chip| {
                        chip.child(
                            div()
                                .id(("detach", id as usize))
                                .size_6()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .cursor_pointer()
                                .hover(move |style| style.bg(quiet_hover))
                                .tooltip(|window, cx| Tooltip::new("Remove").build(window, cx))
                                .on_click(cx.listener(move |this, _, _, cx| this.detach_file(id, cx)))
                                .child(icon("x", px(12.), theme.ink_secondary)),
                        )
                    })
                    .when(sending, |chip| chip.pr_2p5())
            }))
        });

        let attach = div()
            .id("attach")
            .size_7()
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.ink_at(0.04))
            .border_1()
            .border_color(theme.ink_at(0.04))
            .when(sending, |attach| attach.opacity(0.4).child(icon("composer-plus", px(20.), theme.ink_tertiary)))
            .when(!sending, |attach| {
                attach
                    .cursor_pointer()
                    .tooltip(|window, cx| Tooltip::new("Attach files").build(window, cx))
                    .on_click(cx.listener(|this, _, window, cx| this.attach_files(window, cx)))
            });

        let send = div()
            .id("send")
            .size_7()
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(fill)
            .when(sending, |send| send.opacity(0.5))
            .when(stopping || ready, |send| {
                send.cursor_pointer().on_click(cx.listener(move |this, _, window, cx| {
                    if stopping {
                        this.stop(window, cx)
                    } else {
                        this.send(window, cx)
                    }
                }))
            })
            .child(if sending {
                Spinner::new().with_size(px(16.)).color(ink).into_any_element()
            } else if stopping {
                div().size(px(10.)).rounded(px(2.)).bg(ink).into_any_element()
            } else {
                icon("arrow-up", px(16.), ink).into_any_element()
            });

        let attach = attach_control(attach, !sending, theme);
        let send = send_control(send, stopping || ready, fill, ink, theme);
        let name = self.target_name(target);
        let label = match target {
            _ if local.is_some() => format!("Message {name} using the local model"),
            Target::Agent(_) | Target::Conversation { .. } => format!("Message {name}"),
            Target::Group(_) => format!("Message {name}, @ to ask one bot"),
        };
        let field = Textarea::new(&self.composer)
            .small()
            .appearance(false)
            .bordered(false)
            .disabled(sending)
            .aria_label(label.clone());
        let input = div()
            .relative()
            .flex_1()
            .min_w_0()
            .py(px(2.))
            .mx(px(-6.))
            .when(text.is_empty(), |slot| {
                slot.child(
                    div()
                        .absolute()
                        .top(px(4.))
                        .left(px(8.))
                        .right(px(8.))
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .item()
                        .text_color(if sending { theme.ink_at(0.18) } else { theme.ink_secondary })
                        .child(label),
                )
            })
            .child(field);
        let local_mode = local.is_some();
        let apps = self.app_assist_button(theme, cx);
        let pill = div()
            .id("composer")
            .flex()
            .flex_col()
            .gap_2()
            .px(px(8.))
            .pt(px(6.))
            .pb(px(8.))
            .rounded(if multiline || tray.is_some() { radius::BUBBLE } else { radius::COMPOSER })
            .bg(theme.composer)
            .border_1()
            .shadow(composer_shadow())
            .children(tray)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_1p5()
                    .when(!local_mode, |row| row.child(attach))
                    .children(apps)
                    .child(input)
                    .child(send),
            );

        let pill = hover_ring(pill, focused, ring, ring_hover);

        // While the `@` list is open the keys that move through it and choose from it are taken
        // before the text field sees them.
        let composer = div()
            .relative()
            .capture_action(cx.listener(|this, _: &MoveUp, _, cx| {
                if this.move_mention(false, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, _, cx| {
                if this.move_mention(true, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Enter, window, cx| {
                if this.pick_mention(None, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &IndentInline, window, cx| {
                if this.pick_mention(None, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Escape, _, cx| {
                if this.close_mention(cx) {
                    cx.stop_propagation();
                }
            }))
            .children(mentions.map(|list| deferred(self.render_mentions(&list, theme, cx)).with_priority(1)))
            .child(pill);

        div().w_full().flex().justify_center().px_5().pb_4().child(
            div()
                .w_full()
                .max_w(CHAT_COLUMN)
                .flex()
                .flex_col()
                .gap_2()
                .when_some(local, |dock, model| {
                    dock.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .meta()
                                    .text_color(theme.ink_secondary)
                                    .child(format!("{} on this computer", model.label)),
                            )
                            .child(
                                pill_button(
                                    "save-local-note",
                                    "Save note",
                                    Tone::Quiet,
                                    ready && !has_attachments,
                                    theme,
                                )
                                .on_click(cx.listener(|this, _, window, cx| this.send_local_note(window, cx))),
                            ),
                    )
                })
                .when_some(write_problem, |dock, problem| {
                    dock.child(
                        div().flex().items_center().gap_2().child(error_line(problem, theme)).child(
                            pill_button("retry-local-write", "Retry saving", Tone::Quiet, !sending, theme)
                                .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                        ),
                    )
                })
                .when(needs_model, |dock| {
                    dock.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_3()
                            .py_2()
                            .rounded(radius::CARD)
                            .bg(theme.warning.opacity(0.1))
                            .body()
                            .text_color(theme.warning)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .line_clamp(2)
                                    .text_ellipsis()
                                    .child("Connect an AI model so your agents can reply."),
                            )
                            .child(
                                div()
                                    .id("connect-model")
                                    .flex_shrink_0()
                                    .whitespace_nowrap()
                                    .body()
                                    .text_color(theme.accent_text)
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.show_workspace_section(Section::Models, window, cx)
                                    }))
                                    .child("Connect a model"),
                            ),
                    )
                })
                .children(problem.map(|problem| error_line(problem, theme)))
                .child(composer),
        )
    }
}
