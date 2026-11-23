use std::time::Instant;

use gpui_kit::base::input::RopeExt as _;
use gpui_kit::component::input::{Enter, Escape, IndentInline, MoveDown, MoveUp, Textarea};
use gpui_kit::component::spinner::Spinner;
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
use crate::ui::motion::{self, Colors, Levels, Pointer, Tint, Tween};
use crate::ui::tooltip;
use crate::ui::{error_line, icon, pill_button, Tone, Type};

/// The lift shared by the header and composer, in CSS `box-shadow` terms.
pub(super) fn floating_shadow(theme: &Theme) -> Vec<BoxShadow> {
    // GPUI (gpui-pre 0.3.12) takes `blur_radius` as the Gaussian sigma; CSS blur is twice it.
    let shadow = |alpha: f32, y: f32, blur: f32, spread: f32| BoxShadow {
        color: hsla(0., 0., 0., alpha),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur / 2.),
        spread_radius: px(spread),
        inset: false,
    };
    let mut shadows = vec![
        shadow(0.05, 2., 8., -1.),
        shadow(0.03, 1., 2., 0.),
        BoxShadow { color: rgba(0xe4e4e40a).into(), ..shadow(0., 0., 0., 1.) },
    ];
    if theme.is_dark() {
        shadows.push(BoxShadow { color: hsla(0., 0., 1., 0.04), inset: true, ..shadow(0., 1., 0., 0.) });
    }
    shadows
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

struct ComposerMotion {
    target: Target,
    viewport: Size<Pixels>,
    input_width: Pixels,
    height: Tween<Pixels>,
    ready: Tint,
}

impl ComposerMotion {
    fn update_visuals(
        &mut self,
        height: Pixels,
        has_content: bool,
        instant_height: bool,
        reduced_motion: bool,
        now: Instant,
    ) -> (Pixels, f32, bool) {
        let span = motion::duration(motion::GROW, instant_height || reduced_motion);
        let lerp = |from, to, progress| from + (to - from) * progress;
        self.height.aim(height, now, span, motion::EMPHASIS, lerp);
        self.ready.aim(has_content, now, reduced_motion);
        (
            self.height.sample(now, motion::EMPHASIS, lerp),
            self.ready.level(now),
            self.height.moving(now) || self.ready.moving(now),
        )
    }
}

fn editor_height(rows: usize, line: Pixels, viewport_height: Pixels) -> Pixels {
    (line * rows.max(1) as f32).min((viewport_height * 0.4).max(line))
}

fn send_paint(empty: Hsla, full: (Hsla, Hsla), ready: f32) -> (Hsla, Hsla) {
    let quiet = (empty.opacity(0.14), empty.opacity(0.55));
    if ready == 0. {
        return quiet;
    }
    if ready == 1. {
        return full;
    }
    let levels = Levels { hover: ready, press: 0. };
    let between = |rest, active| Colors::new(rest, active, active).sample(levels);
    (between(quiet.0, full.0), between(quiet.1, full.1))
}

impl Desktop {
    pub(super) fn render_composer(
        &mut self,
        target: &Target,
        theme: &Theme,
        window: &mut Window,
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
        let line = editor.line_height().unwrap_or(window.rem_size() * 1.25);
        let viewport = window.viewport_size();
        let input_width = editor.input_bounds().size.width;
        let map = editor.display_map();
        // Enter can add a buffer row before the kit lays out that row in its wrapped projection.
        let rows = map.wrap_row_count() + editor.text().lines_len().saturating_sub(map.buffer_line_count());
        let wanted_height = editor_height(rows, line, viewport.height);
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
        let full = tone.map_or(identity, |tone| (tone.fill, tone.fill_ink));
        let now = Instant::now();
        let still = cx.reduce_motion();
        let state = window.use_keyed_state("composer-motion", cx, |_, _| None::<ComposerMotion>);
        let first_layout = state.read(cx).is_none();
        let (height, color_level) = state.update(cx, |state, _| {
            let initial = || {
                let mut ready = Tint::default();
                ready.aim(has_content, now, true);
                ComposerMotion {
                    target: target.clone(),
                    viewport,
                    input_width,
                    height: Tween::at_rest(wanted_height, now),
                    ready,
                }
            };
            let state = state.get_or_insert_with(initial);
            if &state.target != target {
                *state = initial();
            }
            // A new wrapping width or viewport is a layout change, so it takes effect immediately.
            let resized = state.viewport != viewport || state.input_width != input_width;
            state.viewport = viewport;
            state.input_width = input_width;
            let (height, ready, moving) = state.update_visuals(wanted_height, has_content, resized, still, now);
            if moving {
                window.request_animation_frame();
            }
            (height, ready)
        });
        if first_layout {
            // Keep the kit's wrapping and internal scroll, and let this view own its visible height.
            self.composer.update(cx, |editor, cx| editor.set_rows(1, cx));
        }
        let (fill, ink) = if stopping {
            tone.map_or((theme.ink, theme.app), |tone| (tone.fill, tone.fill_ink))
        } else {
            send_paint(identity.0, full, color_level)
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
                                .map(|button| tooltip::on(button, "Remove"))
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
                    .map(|button| tooltip::on(button, "Attach files"))
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
        // As on the web: an empty draft offers dictation and a voice chat; Send appears once
        // there is something to send, and Stop while a run works.
        let quiet = !has_content && !stopping && !sending;
        let voice = quiet.then(|| {
            // TODO: dictation needs the desktop's own speech capture; until then the control
            // shows and stays disabled.
            let mic = div()
                .id("dictate")
                .size_7()
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.control)
                .opacity(0.5)
                .map(|button| tooltip::on(button, "Dictate"))
                .child(icon("mic", px(16.), theme.ink_tertiary));
            // Voice chats run in the web workspace, which this opens.
            let call = div()
                .id("voice-chat")
                .size_7()
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.ink)
                .cursor_pointer()
                .map(|button| tooltip::on(button, "Start voice chat"))
                .on_click(cx.listener(|this, _, _, cx| this.open_web_workspace(cx)))
                .child(icon("audio-lines", px(16.), theme.app));
            div().flex().items_center().gap_2().child(mic).child(call)
        });
        let name = self.target_name(target);
        let label = match target {
            _ if local.is_some() => format!("Message {name} using the local model"),
            Target::Agent(_) | Target::Conversation { .. } => format!("Message {name}"),
            Target::Group(_) => format!("Message {name}, @ to ask one bot"),
        };
        let field = Textarea::new(&self.composer)
            .small()
            .h(height)
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
            .rounded(if height > line || tray.is_some() { radius::BUBBLE } else { radius::COMPOSER })
            .bg(theme.composer)
            .border_1()
            .shadow(floating_shadow(theme))
            .children(tray)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_1p5()
                    .when(!local_mode, |row| row.child(attach))
                    .children(apps)
                    .child(input)
                    .map(|row| match voice {
                        Some(voice) => row.child(voice),
                        None => row.child(send),
                    }),
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
            .capture_action(cx.listener(|this, event: &Enter, window, cx| {
                if !event.shift && this.pick_mention(None, window, cx) {
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
            .children(mentions.map(|list| {
                let sheet = crate::ui::overlays::menu_enter(
                    "mentions-enter",
                    self.render_mentions(&list, theme, cx),
                    cx,
                    |sheet, remaining| sheet.mb(px(8. - 4. * remaining)),
                );
                deferred(sheet).with_priority(1)
            }))
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

#[cfg(test)]
mod tests {
    use gpui_kit::{px, rgb, size, white, Hsla};

    use super::{editor_height, motion, send_paint, ComposerMotion, Instant, Target, Tint, Tween};

    #[test]
    fn reduced_motion_finishes_composer_growth_and_send_tint() {
        let now = Instant::now();
        let mut composer = ComposerMotion {
            target: Target::Agent("fixture".into()),
            viewport: size(px(925.), px(820.)),
            input_width: px(700.),
            height: Tween::at_rest(px(20.), now),
            ready: Tint::default(),
        };
        assert_eq!(composer.update_visuals(px(40.), true, false, false, now), (px(20.), 0., true));
        assert_eq!(composer.update_visuals(px(40.), true, false, true, now + motion::GROW / 2), (px(40.), 1., false),);
    }

    #[test]
    fn composer_height_reserves_one_line_and_caps_grown_content_at_forty_percent() {
        let line = px(20.);
        let window = px(820.);
        assert_eq!(editor_height(0, line, window), line);
        assert_eq!(editor_height(2, line, window), px(40.));
        assert_eq!(editor_height(25, line, window), px(328.));
        assert_eq!(editor_height(25, line, px(40.)), line);
    }

    #[test]
    fn quiet_send_uses_the_identity_and_settles_on_the_ready_paint() {
        let identity: Hsla = rgb(0x508060).into();
        let full = (identity, white());
        let empty = send_paint(identity, full, 0.);
        assert!((empty.0.a - 0.14).abs() < f32::EPSILON);
        assert!((empty.1.a - 0.55).abs() < f32::EPSILON);
        assert_eq!(send_paint(identity, full, 1.), full);
    }
}
