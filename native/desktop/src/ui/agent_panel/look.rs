//! The agent's avatar editor saves the shared bot colour and appearance-pack overrides separately.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use superbot_avatars::{Bot as Avatar, Paint, Picked};

use super::*;
use crate::api::AgentSummary;
use crate::theme::{BotColor, BOT_COLORS};

/// A pending shared colour and the current pack overrides.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Pick {
    shape: Option<String>,
    pack_color: Option<String>,
    shared_color: Option<BotColor>,
}

impl Pick {
    fn of(avatar: Avatar<'_>) -> Pick {
        Pick {
            shape: avatar.picked.shape.map(str::to_owned),
            pack_color: avatar.picked.color.map(str::to_owned),
            ..Default::default()
        }
    }

    fn has_pack_overrides(&self) -> bool {
        self.shape.is_some() || self.pack_color.is_some()
    }

    fn preview_color<'a>(&self, stored: &'a str) -> &'a str {
        self.shared_color.map_or(stored, |color| color.hex)
    }

    fn settings(&self, saved: &Self, stored_color: &str) -> Value {
        let mut patch = Map::new();
        if self.shape != saved.shape {
            patch.insert("lookShape".into(), json!(self.shape));
        }
        if self.pack_color != saved.pack_color {
            patch.insert("lookColor".into(), json!(self.pack_color));
        }
        if let Some(color) = self.shared_color {
            patch.insert("color".into(), json!(color.avatar_value(stored_color)));
        }
        Value::Object(patch)
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
    fn pick(&mut self, next: Pick) -> Option<Pick> {
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
    fn saved(&mut self) -> Option<Pick> {
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
    fn failed(&mut self, error: String) {
        self.saving = false;
        self.waiting = None;
        self.shown = None;
        self.error = Some(error);
    }

    fn shown(&self) -> Option<&Pick> {
        self.shown.as_ref()
    }
}

pub fn avatar_of(bot: &Bot) -> Avatar<'_> {
    Avatar {
        id: &bot.id,
        name: &bot.name,
        color: &bot.color,
        picked: Picked { shape: bot.look_shape.as_deref(), color: bot.look_color.as_deref() },
    }
}

fn color_swatch(id: impl Into<ElementId>, paint: &Paint, chosen: bool, theme: &Theme) -> Stateful<Div> {
    let disc = div().size(if chosen { px(20.) } else { px(24.) }).rounded_full();
    let disc = match paint {
        Paint::Color(color) => disc.bg(*color),
        Paint::Ink => disc.bg(theme.ink),
        Paint::Gradient(stops) => {
            let first = stops.first().copied().unwrap_or(theme.ink);
            let last = stops.last().copied().unwrap_or(first);
            disc.bg(linear_gradient(160., linear_color_stop(first, 0.), linear_color_stop(last, 1.)))
        }
    };
    let hover = theme.ink_at(0.05);
    div()
        .id(id)
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .when(chosen, |swatch| swatch.border_2().border_color(theme.ink_at(0.8)))
        .hover(move |style| style.bg(hover))
        .child(disc)
}

impl Desktop {
    // The sidebar follows live changes even while the panel's detailed bot is cached.
    fn saved_avatar<'a>(&'a self, bot: &'a Bot) -> Avatar<'a> {
        self.agent(&bot.id).map_or_else(|| avatar_of(bot), AgentSummary::avatar)
    }

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
        let saved = Pick::of(self.saved_avatar(bot));
        let Some(editor) = self.look_editor() else { return };
        let mut next = editor.shown().cloned().unwrap_or(saved);
        change(&mut next);
        if let Some(send) = editor.pick(next) {
            self.save_look(agent_id, send, window, cx);
        }
        cx.notify();
    }

    fn save_look(&mut self, agent_id: String, pick: Pick, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space), Some(bot)) = (self.api.clone(), self.space_id(), self.agent_info.bot(&agent_id))
        else {
            return;
        };
        let saved = self.saved_avatar(bot);
        let settings = pick.settings(&Pick::of(saved), saved.color);
        let id = agent_id.clone();
        let work = async move { api.update_agent(&space, &id, settings).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let error = match result {
                Ok(bot) => {
                    this.remember_look(&bot);
                    None
                }
                Err(error) => Some(error),
            };
            let Some(panel) = this.agent_panel.as_mut().filter(|panel| panel.agent_id == agent_id) else { return };
            if let Some(error) = error {
                panel.look.failed(api::explain(&error));
            } else if let Some(next) = panel.look.saved() {
                this.save_look(agent_id, next, window, cx);
            }
        });
    }

    /// The server's answer becomes what the panel and the sidebar draw.
    fn remember_look(&mut self, bot: &AgentSummary) {
        if let Some(summary) =
            self.space.as_mut().and_then(|space| space.bots.iter_mut().find(|agent| agent.id == bot.id))
        {
            summary.color = bot.color.clone();
            summary.look_shape = bot.look_shape.clone();
            summary.look_color = bot.look_color.clone();
        }
        if let Some(cached) = self.agent_info.bots.get_mut(&bot.id) {
            cached.color = bot.color.clone();
            cached.look_shape = bot.look_shape.clone();
            cached.look_color = bot.look_color.clone();
        }
    }

    /// The hero's avatar: it opens the editor, which hangs under it while open.
    pub(super) fn render_look_avatar(&self, bot: &Bot, working: bool, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let editor = self.agent_panel.as_ref().map(|panel| &panel.look);
        let saved = self.saved_avatar(bot);
        let shown = editor.and_then(LookEditor::shown).cloned().unwrap_or_else(|| Pick::of(saved));
        let open = editor.is_some_and(|editor| editor.open);
        let avatar = Avatar {
            color: shown.preview_color(saved.color),
            picked: Picked { shape: shown.shape.as_deref(), color: shown.pack_color.as_deref() },
            ..saved
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
                        .child(self.render_look_editor(avatar, &shown, editor, theme, cx)),
                )),
            )
        })
    }

    fn render_look_editor(
        &self,
        avatar: Avatar<'_>,
        shown: &Pick,
        editor: Option<&LookEditor>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let choices = superbot_avatars::choices(cx);
        let resolved = superbot_avatars::look(avatar, cx);
        let current_shape = resolved.as_ref().map(|look| look.shape.clone());
        let current_paint = resolved.as_ref().map(|look| look.paint.clone());
        let color_name = |paint: &Paint| -> Option<String> {
            choices.as_ref()?.colors.iter().find(|(_, offered)| offered == paint).map(|(name, _)| name.clone())
        };
        let current_color = shown.pack_color.clone().or_else(|| current_paint.as_ref().and_then(color_name));
        let hover = theme.ink_at(0.05);
        let ring = theme.ink_at(0.25);
        let agent = avatar.id.to_owned();

        let shapes = choices.iter().flat_map(|choices| choices.shapes.iter()).map(|shape| {
            let chosen = current_shape.as_deref() == Some(shape.as_str());
            let mark_id = format!("look:{}:{shape}", avatar.id);
            let key = SharedString::from(format!("look-shape:{shape}"));
            let mark = Avatar {
                id: &mark_id,
                picked: Picked { shape: Some(shape), color: current_color.as_deref() },
                ..avatar
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
            color_swatch(SharedString::from(format!("look-color-{name}")), paint, chosen, theme)
                .tooltip({
                    let name = name.clone();
                    move |window, cx| Tooltip::new(name.clone()).build(window, cx)
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    let color = color_name.clone();
                    this.pick_look(agent.clone(), move |pick| pick.pack_color = Some(color), window, cx)
                }))
        });

        let selected = BotColor::from_value(avatar.color);
        let shared_colors = BOT_COLORS.iter().map(|color| {
            let chosen = selected == Some(color);
            let paint = Paint::Color(theme.identity_for(color.hex));
            let agent = agent.clone();
            color_swatch(color.name, &paint, chosen, theme)
                .tooltip(move |window, cx| Tooltip::new(color.name).build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.pick_look(agent.clone(), |pick| pick.shared_color = Some(*color), window, cx)
                }))
        });

        let quiet = theme.ink_secondary;
        let reset_agent = agent.clone();
        let pack_header = div()
            .flex()
            .items_center()
            .min_h(px(28.))
            .child(div().flex_1().body().text_color(quiet).child("Avatar pack"))
            .when(shown.has_pack_overrides(), |header| {
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
                            this.pick_look(
                                reset_agent.clone(),
                                |pick| {
                                    pick.shape = None;
                                    pick.pack_color = None;
                                },
                                window,
                                cx,
                            )
                        }))
                        .child("Reset"),
                )
            });

        let color_grid =
            || div().max_w(px(236.)).mx_auto().flex().flex_wrap().justify_center().gap_x(px(12.)).gap_y(px(12.));
        let label = |text| div().mb_2().body().text_color(quiet).child(text);
        let body = div().p_3().child(label("Bot color")).child(color_grid().children(shared_colors)).when(
            choices.is_some(),
            |body| {
                body.child(
                    div()
                        .mt_3()
                        .pt_3()
                        .border_t_1()
                        .border_color(theme.ink_at(0.06))
                        .child(pack_header)
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
                        .child(color_grid().pt_4().pb_2().children(colors)),
                )
            },
        );

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
    use super::{json, BotColor, LookEditor, Pick, BOT_COLORS};

    fn pick(shape: &str) -> Pick {
        Pick { shape: Some(shape.into()), ..Default::default() }
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
        assert!(!Pick::default().has_pack_overrides());
        assert!(pick("blob").has_pack_overrides());
    }

    #[test]
    fn a_shared_pick_writes_the_canonical_color_and_keeps_the_studio_shape() {
        let saved = Pick { pack_color: Some("chrome".into()), ..Default::default() };
        for color in BOT_COLORS {
            let next = Pick { shared_color: Some(color), ..saved.clone() };
            let patch = next.settings(&saved, "#0a0::shape_3");
            let stored = patch["color"].as_str().unwrap();
            assert_eq!(patch, json!({ "color": format!("{}::shape_3", color.hex) }));
            assert_eq!(BotColor::from_value(stored), Some(&color));
            assert_eq!(next.settings(&saved, "data:image/png;base64,AAAA"), json!({ "color": color.hex }));
        }
    }

    #[test]
    fn a_pack_pick_or_reset_leaves_the_shared_color_alone() {
        let saved = Pick::default();
        let next = Pick { pack_color: Some("chrome".into()), ..Default::default() };
        assert_eq!(next.settings(&saved, "#FFFFFF"), json!({ "lookColor": "chrome" }));
        assert_eq!(saved.settings(&next, "#FFFFFF"), json!({ "lookColor": null }));
    }
}
