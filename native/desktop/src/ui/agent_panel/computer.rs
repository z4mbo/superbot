use super::*;
use crate::ui::focus::{self, Ring};

impl Desktop {
    pub(super) fn render_computer(
        &self,
        bot: &Bot,
        avatar: superbot_avatars::Bot,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let panel = self.agent_panel.as_ref().expect("rendered with a panel");
        let name = bot.name.clone();
        let busy = panel.computer_busy || panel.saving;
        let on = uses_computer(bot);
        let (mark, title, hint, action): (AnyElement, String, Option<String>, Option<CardAction>) = match &panel
            .computer
        {
            None | Some(ComputerView::Loading) => (
                Spinner::new().with_size(px(16.)).color(theme.ink_tertiary).into_any_element(),
                "Checking its computer…".into(),
                None,
                None,
            ),
            Some(ComputerView::Missing) => (
                icon("monitor-off", px(28.), theme.ink_tertiary).into_any_element(),
                format!("{name} has no computer"),
                None,
                None,
            ),
            Some(ComputerView::Failed(problem)) => (
                icon("monitor-off", px(28.), theme.ink_tertiary).into_any_element(),
                "Couldn't check its computer".into(),
                Some(problem.clone()),
                None,
            ),
            Some(ComputerView::Ready(status)) if !status.offered() => (
                icon("monitor-off", px(28.), theme.ink_tertiary).into_any_element(),
                "This server runs no computers".into(),
                None,
                None,
            ),
            _ if !on => (
                icon("monitor-off", px(28.), theme.ink_tertiary).into_any_element(),
                format!("{name} doesn't use a computer"),
                None,
                Some(CardAction::TurnOn),
            ),
            Some(ComputerView::Ready(status)) if status.runs_on_user_machine => (
                icon("monitor", px(28.), theme.ink_tertiary).into_any_element(),
                "Works on your computer".into(),
                None,
                None,
            ),
            Some(ComputerView::Ready(status)) => {
                let face = |opacity: f32| {
                    div().opacity(opacity).child(self.roster_avatar(avatar, px(44.), theme, cx)).into_any_element()
                };
                let (title, start) = match status.state {
                    ComputerState::Running => match &status.busy_bot_name {
                        Some(user) if *user == name => ("Working on its computer".to_owned(), false),
                        Some(user) => (format!("{user} is using it"), false),
                        None => ("Its computer is on".to_owned(), false),
                    },
                    ComputerState::Booting => ("Starting its computer…".to_owned(), false),
                    ComputerState::Error => ("Its computer ran into a problem".to_owned(), true),
                    ComputerState::Stopped | ComputerState::Suspended => {
                        ("Not using its computer right now".to_owned(), true)
                    }
                };
                let hint = status.controlled_by_other.then(|| "Someone else has control right now.".to_owned());
                let label = match (start, busy) {
                    (true, true) => "Starting…",
                    (true, false) => "Start",
                    (false, true) => "Stopping…",
                    (false, false) => "Stop",
                };
                let action = (!status.controlled_by_other).then_some(CardAction::Power { start, label });
                (face(if start { 0.6 } else { 1. }), title, hint, action)
            }
        };
        let retry = matches!(panel.computer, Some(ComputerView::Failed(_)));
        let float = theme.panel.opacity(0.8);
        let floating = |id: &'static str, glyph: &'static str, label: &'static str| {
            let hover = theme.ink_at(0.1);
            div()
                .id(id)
                .h_7()
                .px(px(10.))
                .flex()
                .items_center()
                .gap_1p5()
                .rounded_full()
                .border_1()
                .border_color(theme.ink_at(0.1))
                .bg(float)
                .meta()
                .text_color(theme.ink)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .child(icon(glyph, px(13.), theme.ink))
                .child(label)
        };
        let remote = match &panel.computer {
            Some(ComputerView::Ready(status)) if on && status.offered() && !status.runs_on_user_machine => Some(status),
            _ => None,
        };
        let watch = remote.filter(|status| status.screen_available).map(|_| {
            floating("agent-computer-watch", "monitor", "Watch")
                .on_click(cx.listener(|this, _, window, cx| this.open_screen(window, cx)))
        });
        let terminal = remote
            .filter(|status| {
                status.terminal_available && status.state == ComputerState::Running && !status.controlled_by_other
            })
            .map(|_| {
                floating("agent-computer-terminal", "square-terminal", "Terminal")
                    .on_click(cx.listener(|this, _, window, cx| this.open_terminal(window, cx)))
            });
        let screen = div()
            .relative()
            .mt(px(10.))
            .w_full()
            .h(px(220.))
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_2()
            .rounded(radius::CARD)
            .bg(theme.composer)
            .border_1()
            .border_color(theme.ink_at(0.06))
            .child(mark)
            .child(div().body().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(title))
            .children(hint.map(|hint| div().body().text_color(theme.ink_secondary).max_w(px(320.)).child(hint)))
            .child(
                div()
                    .absolute()
                    .bottom(px(10.))
                    .right(px(10.))
                    .flex()
                    .gap_2()
                    .children(watch)
                    .children(terminal)
                    .children(action.map(|action| {
                        let (glyph, label) = match action {
                            CardAction::Power { start, label } => (if start { "play" } else { "square" }, label),
                            CardAction::TurnOn => ("power", if busy { "Turning on…" } else { "Turn on" }),
                        };
                        let tools = computer_tools_set(bot, true);
                        div()
                            .id("agent-computer-power")
                            .h_7()
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .rounded_full()
                            .border_1()
                            .border_color(theme.ink_at(0.1))
                            .bg(float)
                            .meta()
                            .text_color(theme.ink)
                            .when(!busy, |button| {
                                let hover = theme.ink_at(0.1);
                                button.cursor_pointer().hover(move |style| style.bg(hover))
                            })
                            .when(busy, |button| button.opacity(0.6))
                            .on_click(cx.listener(move |this, _, window, cx| match action {
                                CardAction::Power { start, .. } => this.switch_computer(start, window, cx),
                                CardAction::TurnOn => {
                                    this.change_agent(Change::DisabledTools(tools.clone()), window, cx)
                                }
                            }))
                            .child(icon(glyph, px(13.), theme.ink))
                            .child(label.to_owned())
                    })),
            )
            .when(retry, |screen| {
                screen.child(
                    crate::ui::pill_button("agent-computer-retry", "Try again", crate::ui::Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.read_computer(window, cx))),
                )
            });

        let color = bot_ink(avatar, theme, cx);
        let tools = computer_tools_set(bot, false);
        let uses_row = div()
            .id("agent-computer-use")
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(46.))
            .px(px(14.))
            .border_b_1()
            .border_color(theme.ink_at(0.05))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                this.change_agent(Change::DisabledTools(tools.clone()), window, cx)
            }))
            .child(icon("monitor", px(16.), theme.ink_secondary))
            .child(div().flex_1().name().text_color(theme.ink).child("Uses a computer"))
            .child(switch(true, color, theme));
        let mode_row = match &panel.computer {
            Some(ComputerView::Ready(status)) if on && status.offered() && !status.runs_on_user_machine => Some(
                card(theme).child(focus::control(uses_row, Ring::TrailingSwitch, theme)).child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2p5()
                        .px(px(14.))
                        .py(px(11.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(icon("app-window", px(16.), theme.ink_secondary))
                                .child(div().name().text_color(theme.ink).child(format!("Where {name} works"))),
                        )
                        .child(div().pl(px(26.)).child(segmented(
                            [("Team computer", ComputerMode::Team), ("Its own computer", ComputerMode::Dedicated)],
                            bot.computer_mode,
                            theme,
                            cx,
                        ))),
                ),
            ),
            _ => None,
        };
        let mode_row = mode_row.map(|row| row.children(self.render_provider_row(theme, cx)));
        let disk = match &panel.computer {
            Some(ComputerView::Ready(status)) => status.disk_full_percent,
            _ => None,
        };

        div()
            .flex()
            .flex_col()
            .child(screen)
            .child(
                div()
                    .mt_3()
                    .flex()
                    .justify_center()
                    .body()
                    .text_color(theme.ink_tertiary)
                    .child(format!("{name}'s computer")),
            )
            .children(mode_row.map(|row| div().mt(px(14.)).child(row)))
            .children(disk.map(|percent| {
                div().mt_3().px(px(14.)).body().text_color(theme.warning).child(format!("Its disk is {percent}% full."))
            }))
            .children(self.render_computer_files(bot, theme, cx))
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum CardAction {
    Power { start: bool, label: &'static str },
    TurnOn,
}
