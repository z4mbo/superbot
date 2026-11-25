//! What the full-screen chat shows and how keys and server answers change it. Pure: the loop in
//! `tui` runs the effects this returns and feeds the results back as messages.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use superbot_client::{Agent, Space};
use superbot_features::{Bot, ThreadSnapshot};

use crate::approvals::{self, PendingApproval};
use crate::stream::{RunEnd, Update};
use crate::threads::Conversation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Focus {
    Agents,
    Conversations,
    Composer,
    Approvals,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Speaker {
    Member(String),
    Agent,
    Superbot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) speaker: Speaker,
    pub(crate) text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentRow {
    pub(crate) id: String,
    pub(crate) name: String,
    /// The bot's identity colour, the only colour on screen.
    pub(crate) color: Option<(u8, u8, u8)>,
}

/// The conversation the chat pane shows. `thread_id` is `None` for the agent's first one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenChat {
    pub(crate) agent_id: String,
    pub(crate) thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    LoadAgents,
    LoadConversations {
        agent_id: String,
    },
    /// Read the conversation, then follow its live events, tagged with `generation`.
    Follow {
        chat: OpenChat,
        generation: u64,
    },
    Send {
        chat: OpenChat,
        text: String,
    },
    NewConversation {
        agent_id: String,
    },
    Answer {
        approval: Box<PendingApproval>,
        answer: &'static str,
    },
    LoadApprovals,
}

#[derive(Debug)]
pub(crate) enum Msg {
    Agents(Vec<Bot>),
    Conversations {
        agent_id: String,
        rows: Vec<Conversation>,
    },
    Snapshot {
        generation: u64,
        snapshot: Box<ThreadSnapshot>,
    },
    Updates {
        generation: u64,
        updates: Vec<Update>,
    },
    Approvals(Vec<PendingApproval>),
    Created {
        agent_id: String,
        thread_id: String,
    },
    Answered,
    /// The roster may have changed; read the agents again.
    RosterChanged,
    /// Runs may have changed; read the approvals again.
    RunsChanged,
    Failed(String),
}

pub(crate) struct App {
    pub(crate) space: Space,
    pub(crate) agents: Vec<AgentRow>,
    pub(crate) agent: usize,
    pub(crate) conversations: Vec<Conversation>,
    pub(crate) conversation: usize,
    pub(crate) open: Option<OpenChat>,
    generation: u64,
    pub(crate) entries: Vec<Entry>,
    pub(crate) draft: String,
    pub(crate) activity: Option<String>,
    pub(crate) working: bool,
    pub(crate) composer: String,
    /// Lines scrolled up from the newest message.
    pub(crate) scroll: u16,
    pub(crate) approvals: Vec<PendingApproval>,
    pub(crate) approval: usize,
    pub(crate) focus: Focus,
    /// A failure to show until the next key.
    pub(crate) notice: Option<String>,
    pub(crate) quit: bool,
}

impl App {
    pub(crate) fn new(space: Space) -> Self {
        Self {
            space,
            agents: Vec::new(),
            agent: 0,
            conversations: Vec::new(),
            conversation: 0,
            open: None,
            generation: 0,
            entries: Vec::new(),
            draft: String::new(),
            activity: None,
            working: false,
            composer: String::new(),
            scroll: 0,
            approvals: Vec::new(),
            approval: 0,
            focus: Focus::Agents,
            notice: None,
            quit: false,
        }
    }

    pub(crate) fn start(&self) -> Vec<Effect> {
        vec![Effect::LoadAgents, Effect::LoadApprovals]
    }

    pub(crate) fn open_agent(&self) -> Option<&AgentRow> {
        let open = self.open.as_ref()?;
        self.agents.iter().find(|agent| agent.id == open.agent_id)
    }

    /// The agents as the approvals scan reads them.
    pub(crate) fn catalog(&self) -> Vec<(Space, Vec<Agent>)> {
        let agents = self
            .agents
            .iter()
            .map(|agent| Agent {
                id: agent.id.clone(),
                name: agent.name.clone(),
            })
            .collect();
        vec![(self.space.clone(), agents)]
    }

    /// Which tabs Tab cycles through: approvals only while some are waiting.
    fn focus_order(&self) -> Vec<Focus> {
        let mut order = vec![Focus::Agents, Focus::Conversations, Focus::Composer];
        if !self.approvals.is_empty() {
            order.push(Focus::Approvals);
        }
        order
    }

    fn cycle_focus(&mut self, step: isize) {
        let order = self.focus_order();
        let at = order
            .iter()
            .position(|focus| *focus == self.focus)
            .unwrap_or(0) as isize;
        let next = (at + step).rem_euclid(order.len() as isize) as usize;
        self.focus = order[next];
    }

    fn open(&mut self, chat: OpenChat) -> Vec<Effect> {
        self.generation += 1;
        self.entries.clear();
        self.draft.clear();
        self.activity = None;
        self.working = false;
        self.scroll = 0;
        self.open = Some(chat.clone());
        vec![Effect::Follow {
            chat,
            generation: self.generation,
        }]
    }

    fn open_selected_agent(&mut self) -> Vec<Effect> {
        let Some(agent) = self.agents.get(self.agent) else {
            return Vec::new();
        };
        let agent_id = agent.id.clone();
        self.conversations.clear();
        self.conversation = 0;
        let mut effects = self.open(OpenChat {
            agent_id: agent_id.clone(),
            thread_id: None,
        });
        effects.push(Effect::LoadConversations { agent_id });
        effects
    }

    pub(crate) fn key(&mut self, key: KeyEvent) -> Vec<Effect> {
        if key.kind == KeyEventKind::Release {
            return Vec::new();
        }
        self.notice = None;
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return Vec::new();
        }
        match key.code {
            KeyCode::Tab => {
                self.cycle_focus(1);
                return Vec::new();
            }
            KeyCode::BackTab => {
                self.cycle_focus(-1);
                return Vec::new();
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_add(10);
                return Vec::new();
            }
            KeyCode::PageDown => {
                self.scroll = self.scroll.saturating_sub(10);
                return Vec::new();
            }
            _ => {}
        }
        match self.focus {
            Focus::Composer => self.composer_key(key),
            Focus::Agents => {
                let effects = match key.code {
                    KeyCode::Enter => {
                        let effects = self.open_selected_agent();
                        self.focus = Focus::Composer;
                        effects
                    }
                    _ => Vec::new(),
                };
                move_in(&mut self.agent, self.agents.len(), key.code);
                self.list_key(key.code, effects)
            }
            Focus::Conversations => {
                let effects = match (key.code, &self.open) {
                    (KeyCode::Enter, Some(open)) => match self.conversations.get(self.conversation)
                    {
                        Some(row) => {
                            let chat = OpenChat {
                                agent_id: open.agent_id.clone(),
                                thread_id: (!row.first).then(|| row.thread_id.clone()),
                            };
                            self.focus = Focus::Composer;
                            self.open(chat)
                        }
                        None => Vec::new(),
                    },
                    (KeyCode::Char('n'), Some(open)) => vec![Effect::NewConversation {
                        agent_id: open.agent_id.clone(),
                    }],
                    _ => Vec::new(),
                };
                move_in(&mut self.conversation, self.conversations.len(), key.code);
                self.list_key(key.code, effects)
            }
            Focus::Approvals => {
                let answer = match key.code {
                    KeyCode::Char('a') => Some("allow"),
                    KeyCode::Char('d') => Some("deny"),
                    _ => None,
                };
                let effects = match (answer, self.approvals.get(self.approval)) {
                    (Some(answer), Some(approval)) => vec![Effect::Answer {
                        approval: Box::new(approval.clone()),
                        answer,
                    }],
                    _ => Vec::new(),
                };
                move_in(&mut self.approval, self.approvals.len(), key.code);
                self.list_key(key.code, effects)
            }
        }
    }

    /// Keys every list shares: `q` quits, `esc` goes to the composer.
    fn list_key(&mut self, code: KeyCode, effects: Vec<Effect>) -> Vec<Effect> {
        match code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Esc => self.focus = Focus::Composer,
            _ => {}
        }
        effects
    }

    fn composer_key(&mut self, key: KeyEvent) -> Vec<Effect> {
        match key.code {
            KeyCode::Esc => self.focus = Focus::Agents,
            KeyCode::Backspace => {
                self.composer.pop();
            }
            KeyCode::Enter => {
                let text = self.composer.trim().to_owned();
                let Some(chat) = self.open.clone() else {
                    return Vec::new();
                };
                if text.is_empty() {
                    return Vec::new();
                }
                self.composer.clear();
                self.scroll = 0;
                self.working = true;
                return vec![Effect::Send { chat, text }];
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.composer.push(ch);
            }
            _ => {}
        }
        Vec::new()
    }

    pub(crate) fn message(&mut self, message: Msg) -> Vec<Effect> {
        match message {
            Msg::Agents(bots) => {
                let selected = self.agents.get(self.agent).map(|agent| agent.id.clone());
                self.agents = bots
                    .into_iter()
                    .filter(|bot| bot.archived_at.is_none())
                    .map(|bot| AgentRow {
                        color: identity_color(&bot.color),
                        id: bot.id,
                        name: bot.name,
                    })
                    .collect();
                self.agent = selected
                    .and_then(|id| self.agents.iter().position(|agent| agent.id == id))
                    .unwrap_or(0);
                if self.open.is_none() && !self.agents.is_empty() {
                    self.focus = Focus::Composer;
                    return self.open_selected_agent();
                }
            }
            Msg::Conversations { agent_id, rows } => {
                if self
                    .open
                    .as_ref()
                    .is_some_and(|open| open.agent_id == agent_id)
                {
                    self.conversation = self
                        .open
                        .as_ref()
                        .and_then(|open| {
                            rows.iter().position(|row| match &open.thread_id {
                                Some(id) => row.thread_id == *id,
                                None => row.first,
                            })
                        })
                        .unwrap_or(0);
                    self.conversations = rows;
                }
            }
            Msg::Snapshot {
                generation,
                snapshot,
            } if generation == self.generation => {
                self.entries = snapshot
                    .messages
                    .iter()
                    .filter_map(|message| {
                        let text = approvals::message_text(message);
                        (!text.trim().is_empty()).then(|| Entry {
                            id: message.id.clone(),
                            speaker: speaker(&message.role, message.author.as_ref()),
                            text,
                        })
                    })
                    .collect();
                self.working = snapshot.run.as_ref().is_some_and(|run| {
                    matches!(run["status"].as_str(), Some("running" | "queued"))
                });
            }
            Msg::Updates {
                generation,
                updates,
            } if generation == self.generation => {
                let mut effects = Vec::new();
                for update in updates {
                    effects.extend(self.update(update));
                }
                return effects;
            }
            Msg::Snapshot { .. } | Msg::Updates { .. } => {}
            Msg::Approvals(found) => {
                self.approvals = found;
                self.approval = self.approval.min(self.approvals.len().saturating_sub(1));
                if self.approvals.is_empty() && self.focus == Focus::Approvals {
                    self.focus = Focus::Composer;
                }
            }
            Msg::Created {
                agent_id,
                thread_id,
            } => {
                if self
                    .open
                    .as_ref()
                    .is_some_and(|open| open.agent_id == agent_id)
                {
                    self.focus = Focus::Composer;
                    let mut effects = self.open(OpenChat {
                        agent_id: agent_id.clone(),
                        thread_id: Some(thread_id),
                    });
                    effects.push(Effect::LoadConversations { agent_id });
                    return effects;
                }
            }
            Msg::Answered | Msg::RunsChanged => return vec![Effect::LoadApprovals],
            Msg::RosterChanged => return vec![Effect::LoadAgents],
            Msg::Failed(reason) => {
                self.working = false;
                self.notice = Some(reason);
            }
        }
        Vec::new()
    }

    fn update(&mut self, update: Update) -> Vec<Effect> {
        match update {
            Update::Draft(delta) => {
                self.working = true;
                self.draft.push_str(&delta);
            }
            Update::DraftWithdrawn => self.draft.clear(),
            Update::Activity(activity) => {
                if activity.is_some() {
                    self.working = true;
                }
                self.activity = activity;
            }
            Update::Message(message) => {
                if message.role == "bot" && !message.text.is_empty() {
                    self.draft.clear();
                }
                if message.text.trim().is_empty() {
                    return Vec::new();
                }
                let entry = Entry {
                    id: message.id,
                    speaker: speaker(&message.role, message.author.as_ref()),
                    text: message.text,
                };
                match self.entries.iter_mut().find(|known| known.id == entry.id) {
                    Some(known) => *known = entry,
                    None => self.entries.push(entry),
                }
            }
            Update::RunEnded { end, .. } => {
                self.working = false;
                self.draft.clear();
                self.activity = None;
                match end {
                    RunEnd::Failed(reason) => {
                        self.notice = Some(format!("Agent run failed. {reason}"));
                    }
                    RunEnd::WaitingInput => return vec![Effect::LoadApprovals],
                    RunEnd::Completed | RunEnd::Cancelled => {}
                }
            }
            Update::Cleared => {
                self.entries.clear();
                self.draft.clear();
            }
        }
        Vec::new()
    }
}

fn speaker(role: &str, author: Option<&superbot_client::MessageAuthor>) -> Speaker {
    match role {
        "user" => Speaker::Member(author.map_or_else(|| "Member".into(), |a| a.name.clone())),
        "bot" => Speaker::Agent,
        _ => Speaker::Superbot,
    }
}

fn move_in(index: &mut usize, len: usize, code: KeyCode) {
    match code {
        KeyCode::Up | KeyCode::Char('k') => *index = index.saturating_sub(1),
        KeyCode::Down | KeyCode::Char('j') if *index + 1 < len => *index += 1,
        _ => {}
    }
}

/// A bot colour value is `#rrggbb`, optionally followed by `::shape_NAME`.
pub(crate) fn identity_color(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.split("::").next()?.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some((channel(0)?, channel(2)?, channel(4)?))
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;
    use superbot_client::Message;

    use super::*;

    pub(crate) fn bot(id: &str, name: &str, color: &str) -> Bot {
        serde_json::from_value(json!({
            "id": id, "spaceId": "space-1", "threadId": format!("thread-{id}"), "name": name,
            "title": "", "description": "", "instructions": "", "color": color, "unread": false,
            "snoozedUntil": null, "preview": "", "status": "idle", "threadStatus": null,
            "updatedAt": "2026-11-20T00:00:00Z", "createdAt": "2026-11-20T00:00:00Z",
            "notifyOnFinish": false, "pinned": false, "sectionId": null, "archivedAt": null,
            "modelProvider": null, "modelId": null, "thinkingLevel": null, "computerMode": "team",
            "autoSpeak": false, "voiceId": null, "replyMode": null, "memoryScope": null,
            "teamChatAmbientEnabled": false, "teamChatRules": "", "crossSpaceCommunication": null,
            "dailyCheckIns": null, "fleetManagement": null,
        }))
        .unwrap()
    }

    pub(crate) fn app() -> App {
        App::new(Space {
            id: "space-1".into(),
            name: "Personal".into(),
            shared: false,
        })
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Effect> {
        app.key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    fn reply(id: &str, role: &str, text: &str) -> Update {
        Update::Message(Message {
            id: id.into(),
            role: role.into(),
            author: None,
            origin: None,
            bot_id: None,
            text: text.into(),
            seq: 1,
            run_id: Some("run-1".into()),
        })
    }

    #[test]
    fn the_first_agent_opens_once_the_roster_arrives() {
        let mut app = app();
        assert_eq!(app.start(), [Effect::LoadAgents, Effect::LoadApprovals]);
        let effects = app.message(Msg::Agents(vec![
            bot("bot-1", "Fixture agent", "#3B82F6::shape_round"),
            bot("bot-2", "Research", "plum"),
        ]));
        let chat = OpenChat {
            agent_id: "bot-1".into(),
            thread_id: None,
        };
        assert_eq!(
            effects,
            [
                Effect::Follow {
                    chat,
                    generation: 1
                },
                Effect::LoadConversations {
                    agent_id: "bot-1".into()
                }
            ]
        );
        assert_eq!(app.agents[0].color, Some((0x3b, 0x82, 0xf6)));
        assert_eq!(app.agents[1].color, None);
        assert_eq!(app.focus, Focus::Composer);
        // A later roster read keeps the selection and does not reopen the chat.
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.focus, Focus::Agents);
        press(&mut app, KeyCode::Down);
        assert!(app
            .message(Msg::Agents(vec![
                bot("bot-0", "Atlas", "#000000"),
                bot("bot-1", "Fixture agent", "#3B82F6"),
                bot("bot-2", "Research", "#ffffff"),
            ]))
            .is_empty());
        assert_eq!(app.agents[app.agent].name, "Research");
    }

    #[test]
    fn typing_sends_to_the_open_chat_and_the_reply_streams_in() {
        let mut app = app();
        app.message(Msg::Agents(vec![bot("bot-1", "Fixture agent", "#3b82f6")]));
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.focus, Focus::Composer);
        for ch in "Hi!".chars() {
            press(&mut app, KeyCode::Char(ch));
        }
        press(&mut app, KeyCode::Backspace);
        let sent = press(&mut app, KeyCode::Enter);
        assert!(
            matches!(&sent[..], [Effect::Send { text, .. }] if text == "Hi"),
            "{sent:?}"
        );
        assert!(app.working && app.composer.is_empty());
        let generation = app.generation;
        app.message(Msg::Updates {
            generation,
            updates: vec![
                reply("m1", "user", "Hi"),
                Update::Draft("The fixture ".into()),
                Update::Draft("response".into()),
            ],
        });
        assert_eq!(app.draft, "The fixture response");
        // Events from a conversation that is no longer open are dropped.
        app.message(Msg::Updates {
            generation: generation - 1,
            updates: vec![Update::Draft(" stale".into())],
        });
        assert_eq!(app.draft, "The fixture response");
        app.message(Msg::Updates {
            generation,
            updates: vec![
                reply("m2", "bot", "The fixture response is blue."),
                Update::RunEnded {
                    run_id: "run-1".into(),
                    end: RunEnd::Completed,
                },
            ],
        });
        assert!(app.draft.is_empty() && !app.working);
        assert_eq!(
            app.entries
                .iter()
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>(),
            ["Hi", "The fixture response is blue."]
        );
    }

    #[test]
    fn conversations_open_from_their_list_and_new_ones_open_when_created() {
        let mut app = app();
        app.message(Msg::Agents(vec![bot("bot-1", "Fixture agent", "#3b82f6")]));
        app.message(Msg::Conversations {
            agent_id: "bot-1".into(),
            rows: vec![
                Conversation {
                    thread_id: "thread-1".into(),
                    first: true,
                    title: None,
                    preview: None,
                },
                Conversation {
                    thread_id: "thread-2".into(),
                    first: false,
                    title: Some("Launch plan".into()),
                    preview: None,
                },
            ],
        });
        press(&mut app, KeyCode::BackTab);
        assert_eq!(app.focus, Focus::Conversations);
        press(&mut app, KeyCode::Down);
        let opened = press(&mut app, KeyCode::Enter);
        assert!(matches!(&opened[..], [Effect::Follow { chat, .. }]
            if chat.thread_id.as_deref() == Some("thread-2")));
        app.focus = Focus::Conversations;
        assert_eq!(
            press(&mut app, KeyCode::Char('n')),
            [Effect::NewConversation {
                agent_id: "bot-1".into()
            }]
        );
        let created = app.message(Msg::Created {
            agent_id: "bot-1".into(),
            thread_id: "thread-3".into(),
        });
        assert!(matches!(&created[0], Effect::Follow { chat, .. }
            if chat.thread_id.as_deref() == Some("thread-3")));
        assert_eq!(app.focus, Focus::Composer);
    }

    fn pending(id: &str) -> PendingApproval {
        PendingApproval {
            id: id.into(),
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
        }
    }

    #[test]
    fn approvals_join_the_tab_order_only_while_waiting_and_answer_by_key() {
        let mut app = app();
        let order = |app: &mut App| {
            (0..4)
                .map(|_| {
                    press(app, KeyCode::Tab);
                    app.focus
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            order(&mut app),
            [
                Focus::Conversations,
                Focus::Composer,
                Focus::Agents,
                Focus::Conversations
            ]
        );
        app.message(Msg::Approvals(vec![
            pending("message-1"),
            pending("message-2"),
        ]));
        app.focus = Focus::Composer;
        press(&mut app, KeyCode::Tab);
        assert_eq!(app.focus, Focus::Approvals);
        press(&mut app, KeyCode::Down);
        let effects = press(&mut app, KeyCode::Char('d'));
        assert!(
            matches!(&effects[..], [Effect::Answer { approval, answer: "deny" }]
            if approval.id == "message-2")
        );
        assert_eq!(app.message(Msg::Answered), [Effect::LoadApprovals]);
        app.message(Msg::Approvals(Vec::new()));
        assert_eq!(app.focus, Focus::Composer);
    }

    #[test]
    fn a_waiting_run_reads_approvals_and_a_failure_shows_until_the_next_key() {
        let mut app = app();
        app.message(Msg::Agents(vec![bot("bot-1", "Fixture agent", "#3b82f6")]));
        let generation = app.generation;
        let effects = app.message(Msg::Updates {
            generation,
            updates: vec![Update::RunEnded {
                run_id: "run-1".into(),
                end: RunEnd::WaitingInput,
            }],
        });
        assert_eq!(effects, [Effect::LoadApprovals]);
        app.message(Msg::Updates {
            generation,
            updates: vec![Update::RunEnded {
                run_id: "run-1".into(),
                end: RunEnd::Failed("Model unavailable".into()),
            }],
        });
        assert_eq!(
            app.notice.as_deref(),
            Some("Agent run failed. Model unavailable")
        );
        press(&mut app, KeyCode::Char('x'));
        assert!(app.notice.is_none());
        assert_eq!(app.message(Msg::RunsChanged), [Effect::LoadApprovals]);
        assert_eq!(app.message(Msg::RosterChanged), [Effect::LoadAgents]);
    }

    #[test]
    fn q_quits_from_lists_but_types_in_the_composer() {
        let mut app = app();
        app.focus = Focus::Composer;
        app.open = Some(OpenChat {
            agent_id: "bot-1".into(),
            thread_id: None,
        });
        press(&mut app, KeyCode::Char('q'));
        assert!(!app.quit);
        assert_eq!(app.composer, "q");
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char('q'));
        assert!(app.quit);
        let mut app = super::tests::app();
        app.focus = Focus::Composer;
        app.key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(app.quit);
    }
}
