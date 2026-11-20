//! The agent's avatar editor: pick its shape and colour from the local avatar pack. A pick is
//! saved on the bot at once, as Grok Bot's editor does, so everyone in the space sees it.

use std::time::{Duration, Instant};

use superbot_avatars::{Paint, Picked};
use superbot_features::Patch;

use super::*;

/// A whole look after a pick; `None` fields are left to the pack.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pick {
    pub shape: Option<String>,
    pub color: Option<String>,
}

impl Pick {
    pub fn of(bot: &Bot) -> Pick {
        Pick { shape: bot.look_shape.clone(), color: bot.look_color.clone() }
    }

    pub fn is_set(&self) -> bool {
        self.shape.is_some() || self.color.is_some()
    }

    fn settings(&self) -> BotSettings<'_> {
        BotSettings { look_shape: patch(&self.shape), look_color: patch(&self.color), ..Default::default() }
    }
}

fn patch(value: &Option<String>) -> Patch<&str> {
    match value {
        Some(name) => Patch::Set(name.as_str()),
        None => Patch::Clear,
    }
}

/// The saves of one panel, in order: a pick made while one is on its way waits and replaces
/// any pick that was waiting, so the last pick is what the server keeps.
#[derive(Default)]
pub struct LookEditor {
    pub open: bool,
    /// The look on screen before the server confirms it.
    shown: Option<Pick>,
    saving: bool,
    waiting: Option<Pick>,
    error: Option<String>,
    closed_at: Option<Instant>,
}

impl LookEditor {
    /// What to send now for `next`, or `None` when it waits behind a save on its way.
    pub fn pick(&mut self, next: Pick) -> Option<Pick> {
        self.shown = Some(next.clone());
        self.error = None;
        if self.saving {
            self.waiting = Some(next);
            None
        } else {
            self.saving = true;
            Some(next)
        }
    }

    /// A save finished; returns the waiting pick to send next.
    pub fn saved(&mut self) -> Option<Pick> {
        match self.waiting.take() {
            Some(next) => Some(next),
            None => {
                self.saving = false;
                self.shown = None;
                None
            }
        }
    }

    /// A save failed: the server's look stands and nothing waits.
    pub fn failed(&mut self, error: String) {
        self.saving = false;
        self.waiting = None;
        self.shown = None;
        self.error = Some(error);
    }

    pub fn shown(&self) -> Option<&Pick> {
        self.shown.as_ref()
    }
}

pub fn avatar_of(bot: &Bot) -> superbot_avatars::Bot<'_> {
    superbot_avatars::Bot {
        id: &bot.id,
        name: &bot.name,
        color: &bot.color,
        picked: Picked { shape: bot.look_shape.as_deref(), color: bot.look_color.as_deref() },
    }
}

fn swatch(paint: &Paint, size: Pixels, theme: &Theme) -> Div {
    let fill = div().size(size).rounded_full();
    match paint {
        Paint::Color(color) => fill.bg(*color),
        Paint::Ink => fill.bg(theme.ink),
        Paint::Gradient(stops) => {
            let first = stops.first().copied().unwrap_or(theme.ink);
            let last = stops.last().copied().unwrap_or(first);
            fill.bg(linear_gradient(160., linear_color_stop(first, 0.), linear_color_stop(last, 1.)))
        }
    }
}

impl Desktop {
    fn look_editor(&mut self) -> Option<&mut LookEditor> {
        self.agent_panel.as_mut().map(|panel| &mut panel.look)
    }

    /// Opens or closes the editor from the avatar. A click that just closed it by landing
    /// outside it does not open it again.
    pub(super) fn toggle_look_editor(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.look_editor() else { return };
        let just_closed = editor.closed_at.is_some_and(|at| at.elapsed() < Duration::from_millis(300));
        editor.open = !editor.open && !just_closed;
        editor.error = None;
        cx.notify();
    }

    pub(super) fn close_look_editor(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(editor) = self.look_editor().filter(|editor| editor.open) else { return false };
        editor.open = false;
        editor.closed_at = Some(Instant::now());
        cx.notify();
        true
    }

    fn pick_look(
        &mut self,
        agent_id: String,
        change: impl FnOnce(&mut Pick),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bot) = self.agent_info.bot(&agent_id) else { return };
        let saved = Pick::of(bot);
        let Some(editor) = self.look_editor() else { return };
        let mut next = editor.shown().cloned().unwrap_or(saved);
        change(&mut next);
        if let Some(send) = editor.pick(next) {
            self.save_look(agent_id, send, window, cx);
        }
        cx.notify();
    }

    fn save_look(&mut self, agent_id: String, pick: Pick, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.features() else { return };
        let id = agent_id.clone();
        let work = async move { features.space(space).update_bot(&id, &pick.settings()).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let next = match result {
                Ok(bot) => {
                    this.remember_look(&agent_id, &bot);
                    this.look_editor().and_then(LookEditor::saved)
                }
                Err(error) => {
                    if let Some(editor) = this.look_editor() {
                        editor.failed(api::explain(&error));
                    }
                    None
                }
            };
            if let Some(next) = next {
                this.save_look(agent_id, next, window, cx);
            }
        });
    }

    /// The server's answer becomes what the panel and the sidebar draw.
    fn remember_look(&mut self, agent_id: &str, bot: &Bot) {
        if let Some(summary) =
            self.space.as_mut().and_then(|space| space.bots.iter_mut().find(|agent| agent.id == agent_id))
        {
            summary.look_shape = bot.look_shape.clone();
            summary.look_color = bot.look_color.clone();
        }
        self.agent_info.bots.insert(agent_id.to_owned(), bot.clone());
    }

    /// The hero's avatar: it opens the editor, which hangs under it while open.
    pub(super) fn render_look_avatar(&self, bot: &Bot, working: bool, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let editor = self.agent_panel.as_ref().map(|panel| &panel.look);
        let shown = editor.and_then(LookEditor::shown).cloned().unwrap_or_else(|| Pick::of(bot));
        let open = editor.is_some_and(|editor| editor.open);
        let avatar = superbot_avatars::Bot {
            id: &bot.id,
            name: &bot.name,
            color: &bot.color,
            picked: Picked { shape: shown.shape.as_deref(), color: shown.color.as_deref() },
        };
        let hover = theme.ink_at(0.06);
        let face = div()
            .id("agent-look")
            .p_1()
            .rounded_full()
            .cursor_pointer()
            .when(open, |face| face.bg(hover))
            .hover(move |style| style.bg(hover))
            .tooltip(|window, cx| Tooltip::new("Edit avatar").build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_look_editor(cx)))
            .child(bot_avatar(avatar, px(64.), working, None, theme, cx));
        div().flex().flex_col().items_center().child(face).when(open, |column| {
            column.child(
                div().w(px(300.)).h_0().child(deferred(
                    anchored()
                        .snap_to_window_with_margin(px(8.))
                        .child(self.render_look_editor(bot, &shown, editor, theme, cx)),
                )),
            )
        })
    }

    fn render_look_editor(
        &self,
        bot: &Bot,
        shown: &Pick,
        editor: Option<&LookEditor>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let choices = superbot_avatars::choices(cx);
        let resolved = superbot_avatars::look(
            superbot_avatars::Bot {
                id: &bot.id,
                name: &bot.name,
                color: &bot.color,
                picked: Picked { shape: shown.shape.as_deref(), color: shown.color.as_deref() },
            },
            cx,
        );
        let current_shape = resolved.as_ref().map(|look| look.shape.clone());
        let current_paint = resolved.as_ref().map(|look| look.paint.clone());
        let color_name = |paint: &Paint| -> Option<String> {
            choices.as_ref()?.colors.iter().find(|(_, offered)| offered == paint).map(|(name, _)| name.clone())
        };
        let current_color = shown.color.clone().or_else(|| current_paint.as_ref().and_then(color_name));
        let hover = theme.ink_at(0.05);
        let ring = theme.ink_at(0.25);
        let agent = bot.id.clone();

        let shapes = choices.iter().flat_map(|choices| choices.shapes.iter()).map(|shape| {
            let chosen = current_shape.as_deref() == Some(shape.as_str());
            let mark_id = format!("look:{}:{shape}", bot.id);
            let key = SharedString::from(format!("look-shape:{shape}"));
            let mark = superbot_avatars::Bot {
                id: &mark_id,
                name: &bot.name,
                color: &bot.color,
                picked: Picked { shape: Some(shape), color: current_color.as_deref() },
            };
            let (agent, shape_name) = (agent.clone(), shape.clone());
            superbot_avatars::watch_region(
                div()
                    .id(SharedString::from(format!("look-shape-{shape}")))
                    .size(px(52.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .when(chosen, |button| button.border(px(1.5)).border_color(ring))
                    .hover(move |style| style.bg(hover))
                    .tooltip({
                        let name = shape.clone();
                        move |window, cx| Tooltip::new(name.clone()).build(window, cx)
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let shape = shape_name.clone();
                        this.pick_look(agent.clone(), move |pick| pick.shape = Some(shape), window, cx)
                    })),
                key.clone(),
            )
            .child(bot_avatar(mark, px(36.), false, Some(key), theme, cx))
        });

        let colors = choices.iter().flat_map(|choices| choices.colors.iter()).map(|(name, paint)| {
            let chosen = current_color.as_deref() == Some(name.as_str());
            let (agent, color_name) = (agent.clone(), name.clone());
            div()
                .id(SharedString::from(format!("look-color-{name}")))
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .cursor_pointer()
                .when(chosen, |swatch| swatch.border_2().border_color(theme.ink_at(0.8)))
                .tooltip({
                    let name = name.clone();
                    move |window, cx| Tooltip::new(name.clone()).build(window, cx)
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    let color = color_name.clone();
                    this.pick_look(agent.clone(), move |pick| pick.color = Some(color), window, cx)
                }))
                .child(swatch(paint, if chosen { px(20.) } else { px(24.) }, theme))
        });

        let set = shown.is_set();
        let quiet = theme.ink_secondary;
        let reset_agent = agent.clone();
        let header = div()
            .flex()
            .items_center()
            .gap_0p5()
            .p_2()
            .border_b_1()
            .border_color(theme.ink_at(0.06))
            .child(
                div()
                    .px(px(11.))
                    .py(px(5.))
                    .rounded(radius::FIELD)
                    .bg(theme.ink_at(0.08))
                    .body()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .child("Avatar"),
            )
            .child(div().flex_1())
            .when(set, |header| {
                header.child(
                    div()
                        .id("look-reset")
                        .px(px(11.))
                        .py(px(5.))
                        .rounded(radius::FIELD)
                        .body()
                        .text_color(quiet)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.pick_look(reset_agent.clone(), |pick| *pick = Pick::default(), window, cx)
                        }))
                        .child("Reset"),
                )
            });

        let body = match &choices {
            None => div()
                .p_3()
                .body()
                .text_color(theme.ink_secondary)
                .child("Avatar shapes come from the avatar pack in your appearance folder.")
                .into_any_element(),
            Some(_) => div()
                .p_3()
                .child(
                    div()
                        .max_w(px(272.))
                        .mx_auto()
                        .pt_1()
                        .flex()
                        .flex_wrap()
                        .justify_center()
                        .gap_x(px(2.))
                        .gap_y(px(6.))
                        .children(shapes),
                )
                .child(
                    div()
                        .max_w(px(236.))
                        .mx_auto()
                        .pt_4()
                        .pb_2()
                        .flex()
                        .flex_wrap()
                        .justify_center()
                        .gap_x(px(12.))
                        .gap_y(px(12.))
                        .children(colors),
                )
                .into_any_element(),
        };

        div()
            .id("look-editor")
            .mt_2()
            .w(px(300.))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(16.))
            .border_1()
            .border_color(theme.ink_at(0.08))
            .bg(theme.menu)
            .shadow(theme.float_shadow())
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.close_look_editor(cx);
            }))
            .child(header)
            .child(body)
            .children(
                editor
                    .and_then(|editor| editor.error.clone())
                    .map(|error| div().px_3().pb_3().child(error_line(error, theme))),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{LookEditor, Pick};

    fn pick(shape: &str) -> Pick {
        Pick { shape: Some(shape.into()), color: None }
    }

    #[test]
    fn a_pick_made_while_one_saves_waits_and_the_last_one_wins() {
        let mut editor = LookEditor::default();
        assert_eq!(editor.pick(pick("blob")), Some(pick("blob")));
        assert_eq!(editor.pick(pick("cloud")), None);
        assert_eq!(editor.pick(pick("heart")), None);
        assert_eq!(editor.shown(), Some(&pick("heart")));
        assert_eq!(editor.saved(), Some(pick("heart")));
        assert_eq!(editor.saved(), None);
        assert_eq!(editor.shown(), None);
    }

    #[test]
    fn a_failed_save_drops_the_preview_and_what_waited() {
        let mut editor = LookEditor::default();
        editor.pick(pick("blob"));
        editor.pick(pick("cloud"));
        editor.failed("Couldn't reach the server.".into());
        assert_eq!(editor.shown(), None);
        assert_eq!(editor.pick(pick("star")), Some(pick("star")));
    }

    #[test]
    fn reset_is_a_look_with_nothing_picked() {
        assert!(!Pick::default().is_set());
        assert!(pick("blob").is_set());
    }
}
