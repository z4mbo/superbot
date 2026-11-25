//! Draws the full-screen chat: agents, their conversations and waiting approvals on the left,
//! the open conversation and composer on the right, and one line of key hints.

use ratatui::{
    layout::{Constraint, Layout, Position, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, List, ListItem, ListState, Paragraph},
    Frame,
};

use super::state::{App, Entry, Focus, Speaker};
use crate::terminal_text;

const SIDEBAR: u16 = 30;

pub(crate) fn draw(frame: &mut Frame, app: &App) {
    let [main, hints] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(1)]).areas(frame.area());
    let sidebar = SIDEBAR.min(main.width / 3);
    let [left, right] =
        Layout::horizontal([Constraint::Length(sidebar), Constraint::Min(10)]).areas(main);
    let approvals = if app.approvals.is_empty() {
        0
    } else {
        (app.approvals.len() as u16 + 2).min(left.height / 3)
    };
    let [agents, conversations, waiting] = Layout::vertical([
        Constraint::Min(3),
        Constraint::Min(3),
        Constraint::Length(approvals),
    ])
    .areas(left);
    agent_list(frame, app, agents);
    conversation_list(frame, app, conversations);
    if approvals > 0 {
        approval_list(frame, app, waiting);
    }
    let [transcript, composer] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(3)]).areas(right);
    chat(frame, app, transcript);
    composer_box(frame, app, composer);
    frame.render_widget(hint_line(app), hints);
}

fn block(title: Line<'_>, focused: bool) -> Block<'_> {
    let border = if focused {
        Style::new()
    } else {
        Style::new().fg(Color::DarkGray)
    };
    Block::bordered().border_style(border).title(title)
}

fn identity(color: Option<(u8, u8, u8)>) -> Style {
    color.map_or(Style::new(), |(red, green, blue)| {
        Style::new().fg(Color::Rgb(red, green, blue))
    })
}

fn list<'a>(items: Vec<ListItem<'a>>, title: Line<'a>, focused: bool) -> List<'a> {
    let selected = if focused {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new().add_modifier(Modifier::BOLD)
    };
    List::new(items)
        .block(block(title, focused))
        .highlight_style(selected)
}

fn render_list(frame: &mut Frame, widget: List<'_>, selected: usize, len: usize, area: Rect) {
    let mut state = ListState::default().with_selected((len > 0).then_some(selected));
    frame.render_stateful_widget(widget, area, &mut state);
}

fn agent_list(frame: &mut Frame, app: &App, area: Rect) {
    let items = app
        .agents
        .iter()
        .map(|agent| {
            ListItem::new(Span::styled(
                terminal_text(&agent.name),
                identity(agent.color),
            ))
        })
        .collect();
    let widget = list(items, Line::from(" Agents "), app.focus == Focus::Agents);
    render_list(frame, widget, app.agent, app.agents.len(), area);
}

fn conversation_list(frame: &mut Frame, app: &App, area: Rect) {
    let items = app
        .conversations
        .iter()
        .map(|row| ListItem::new(first_line(&terminal_text(row.label()))))
        .collect();
    let focused = app.focus == Focus::Conversations;
    let widget = list(items, Line::from(" Conversations "), focused);
    render_list(
        frame,
        widget,
        app.conversation,
        app.conversations.len(),
        area,
    );
}

fn approval_list(frame: &mut Frame, app: &App, area: Rect) {
    let items = app
        .approvals
        .iter()
        .map(|approval| {
            let color = app
                .agents
                .iter()
                .find(|agent| agent.id == approval.agent_id)
                .and_then(|agent| agent.color);
            // The question first, so a narrow sidebar cuts the agent's name instead.
            ListItem::new(Line::from(vec![
                Span::raw(first_line(&terminal_text(&approval.title))),
                Span::raw(" "),
                Span::styled(terminal_text(&approval.agent_name), identity(color)),
            ]))
        })
        .collect();
    let title = Line::from(format!(" Approvals {} ", app.approvals.len()));
    let widget = list(items, title, app.focus == Focus::Approvals);
    render_list(frame, widget, app.approval, app.approvals.len(), area);
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_owned()
}

fn chat(frame: &mut Frame, app: &App, area: Rect) {
    let agent = app.open_agent();
    let agent_name = agent.map_or("", |agent| agent.name.as_str());
    let agent_style = identity(agent.and_then(|agent| agent.color));
    let mut title = vec![Span::raw(" ")];
    if let Some(agent) = agent {
        title.push(Span::styled(terminal_text(&agent.name), agent_style));
        let conversation = app.conversations.get(app.conversation);
        if let Some(row) = conversation.filter(|_| !app.conversations.is_empty()) {
            title.push(Span::raw(format!(
                " · {}",
                first_line(&terminal_text(row.label()))
            )));
        }
        title.push(Span::raw(" "));
    }
    let inner = Block::bordered().inner(area);
    let width = inner.width.max(1) as usize;
    let lines = transcript(app, agent_name, agent_style, width);
    let height = inner.height as usize;
    let newest = lines.len().saturating_sub(height);
    let top = newest.saturating_sub(app.scroll as usize);
    let shown: Vec<Line> = lines.into_iter().skip(top).take(height).collect();
    frame.render_widget(
        Paragraph::new(shown).block(block(Line::from(title), false)),
        area,
    );
}

/// The conversation as wrapped lines: each message under its speaker, then the streaming reply.
pub(crate) fn transcript(
    app: &App,
    agent_name: &str,
    agent_style: Style,
    width: usize,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let name_line = |name: &str, style: Style| {
        Line::from(Span::styled(
            terminal_text(name),
            style.add_modifier(Modifier::BOLD),
        ))
    };
    let push_text = |lines: &mut Vec<Line<'static>>, text: &str, style: Style| {
        for line in wrap(&terminal_text(text), width) {
            lines.push(Line::from(Span::styled(line, style)));
        }
    };
    for Entry { speaker, text, .. } in &app.entries {
        if !lines.is_empty() {
            lines.push(Line::default());
        }
        let (name, style) = match speaker {
            Speaker::Member(name) => (name.as_str(), Style::new()),
            Speaker::Agent => (agent_name, agent_style),
            Speaker::Superbot => ("Superbot", Style::new()),
        };
        lines.push(name_line(name, style));
        push_text(&mut lines, text, Style::new());
    }
    if app.working || !app.draft.is_empty() {
        if !lines.is_empty() {
            lines.push(Line::default());
        }
        lines.push(name_line(agent_name, agent_style));
        if app.draft.is_empty() {
            let doing = app.activity.as_deref().unwrap_or("Working…");
            push_text(&mut lines, doing, Style::new().fg(Color::DarkGray));
        } else {
            push_text(&mut lines, &format!("{}▍", app.draft), Style::new());
        }
    }
    lines
}

/// Wraps at spaces to `width` columns, breaking words longer than a line.
pub(crate) fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        let mut length = 0;
        for word in paragraph.split(' ') {
            let mut word: Vec<char> = word.chars().collect();
            let gap = usize::from(length > 0);
            if length + gap + word.len() > width && length > 0 {
                lines.push(std::mem::take(&mut line));
                length = 0;
            } else if gap == 1 {
                line.push(' ');
                length += 1;
            }
            while word.len() > width {
                let rest = word.split_off(width);
                lines.push(word.into_iter().collect());
                word = rest;
            }
            length += word.len();
            line.extend(word);
        }
        lines.push(line);
    }
    lines
}

fn composer_box(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == Focus::Composer;
    let inner = Block::bordered().inner(area);
    let text: Vec<char> = app.composer.chars().collect();
    let visible = inner.width.saturating_sub(1) as usize;
    let shown: String = text[text.len().saturating_sub(visible)..].iter().collect();
    let widget = Paragraph::new(terminal_text(&shown)).block(block(Line::default(), focused));
    frame.render_widget(widget, area);
    if focused {
        let column = shown.chars().count() as u16;
        frame.set_cursor_position(Position::new(inner.x + column, inner.y));
    }
}

fn hint_line(app: &App) -> Paragraph<'static> {
    if let Some(notice) = &app.notice {
        return Paragraph::new(first_line(&terminal_text(notice)));
    }
    let hints: &[(&str, &str)] = match app.focus {
        Focus::Agents => &[
            ("↑↓", "select"),
            ("enter", "open"),
            ("tab", "next"),
            ("q", "quit"),
        ],
        Focus::Conversations => &[
            ("↑↓", "select"),
            ("enter", "open"),
            ("n", "new"),
            ("tab", "next"),
            ("q", "quit"),
        ],
        Focus::Composer => &[
            ("enter", "send"),
            ("pgup/pgdn", "scroll"),
            ("tab", "next"),
            ("esc", "agents"),
            ("ctrl-c", "quit"),
        ],
        Focus::Approvals => &[
            ("↑↓", "select"),
            ("a", "allow"),
            ("d", "deny"),
            ("tab", "next"),
            ("q", "quit"),
        ],
    };
    let mut spans = Vec::new();
    for (key, action) in hints {
        if !spans.is_empty() {
            spans.push(Span::raw("  "));
        }
        spans.push(Span::styled(
            *key,
            Style::new().add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {action}"),
            Style::new().fg(Color::DarkGray),
        ));
    }
    Paragraph::new(Line::from(spans))
}

#[cfg(test)]
mod tests {
    use ratatui::{backend::TestBackend, Terminal};

    use super::super::state::Msg;
    use super::*;
    use crate::stream::Update;
    use crate::threads::Conversation;

    fn screen(app: &App, width: u16, height: u16) -> (Vec<String>, ratatui::buffer::Buffer) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let rows = (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect::<String>()
            })
            .collect();
        (rows, buffer)
    }

    fn chatting() -> App {
        let mut app = super::super::state::tests::app();
        app.message(Msg::Agents(vec![
            super::super::state::tests::bot("bot-1", "Fixture agent", "#3b82f6"),
            super::super::state::tests::bot("bot-2", "Research", "#22c55e"),
        ]));
        app.message(Msg::Conversations {
            agent_id: "bot-1".into(),
            rows: vec![Conversation {
                thread_id: "thread-1".into(),
                first: true,
                title: None,
                preview: None,
            }],
        });
        app
    }

    #[test]
    fn lists_agents_in_their_colour_and_shows_the_key_hints() {
        let mut app = chatting();
        app.focus = Focus::Agents;
        let (rows, buffer) = screen(&app, 100, 20);
        assert!(rows[0].contains("Agents") && rows[0].contains("Fixture agent"));
        assert!(rows.iter().any(|row| row.contains("Research")));
        assert!(rows.iter().any(|row| row.contains("First conversation")));
        assert!(rows[19].starts_with("↑↓ select  enter open  tab next  q quit"));
        assert!(!rows.iter().any(|row| row.contains("Approvals")));
        let research = rows
            .iter()
            .position(|row| row.contains("Research"))
            .unwrap();
        let column = rows[research].find("Research").unwrap();
        let x = rows[research][..column].chars().count() as u16;
        assert_eq!(
            buffer[(x, research as u16)].fg,
            Color::Rgb(0x22, 0xc5, 0x5e)
        );
    }

    #[test]
    fn the_streaming_reply_draws_under_the_agent_with_a_caret() {
        let mut app = chatting();
        app.focus = Focus::Composer;
        app.composer = "next question".into();
        assert!(app.open.is_some());
        app.message(Msg::Updates {
            // The agent opened when the roster arrived is the first conversation followed.
            generation: 1,
            updates: vec![Update::Draft("The fixture response".into())],
        });
        let (rows, _) = screen(&app, 100, 20);
        let text = rows.join("\n");
        assert!(text.contains("The fixture response▍"), "{text}");
        assert!(text.contains("next question"));
        assert!(rows[19].starts_with("enter send"));
    }

    #[test]
    fn waiting_approvals_get_their_own_panel() {
        let mut app = chatting();
        app.message(Msg::Approvals(vec![crate::approvals::PendingApproval {
            id: "message-1".into(),
            space_id: "space-1".into(),
            space_name: "Personal".into(),
            agent_id: "bot-1".into(),
            agent_name: "Fixture agent".into(),
            thread_id: "thread-1".into(),
            conversation: None,
            run_id: "run-1".into(),
            title: "Allow web_fetch?".into(),
            site: None,
            detail: None,
        }]));
        let (rows, _) = screen(&app, 100, 24);
        let text = rows.join("\n");
        assert!(text.contains("Approvals 1"), "{text}");
        assert!(text.contains("Allow web_fetch?"));
    }

    #[test]
    fn a_failure_replaces_the_hints_and_narrow_terminals_still_draw() {
        let mut app = chatting();
        app.message(Msg::Failed("Could not send the message.".into()));
        let (rows, _) = screen(&app, 100, 20);
        assert!(rows[19].starts_with("Could not send the message."));
        screen(&app, 20, 6);
    }

    #[test]
    fn wrap_breaks_at_spaces_and_splits_long_words() {
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("a\n\nb", 10), ["a", "", "b"]);
    }
}
