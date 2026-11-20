use std::collections::{HashMap, HashSet};

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use superbot_features::{BotConversation, BotConversationPatch, Features};

use super::{Desktop, Menu, MenuKind};
use crate::api::{self, Target};

/// Conversations the agent panel lists before "Show more", as the reference card does.
pub const SHOWN: usize = 3;
/// The server keeps titles to this many characters.
const TITLE_MAX: usize = 120;

/// Every agent's extra conversations this window has read, and which one each agent last had
/// open, so its sidebar row returns to it.
#[derive(Default)]
pub struct Conversations {
    lists: HashMap<String, Vec<BotConversation>>,
    read: HashMap<String, u64>,
    reading: HashSet<String>,
    current: HashMap<String, String>,
    creating: Option<String>,
    saving: HashSet<String>,
    renaming: Option<Rename>,
    pub expanded: bool,
    pub show_archived: bool,
    pub problem: Option<String>,
}

pub struct Rename {
    pub thread: String,
    pub input: Entity<InputState>,
    pub problem: Option<String>,
    _events: Subscription,
}

/// One row of the agent panel's Conversations card.
pub struct Row {
    /// The conversation's own thread; `None` for the agent's first conversation, which has no
    /// actions of its own.
    pub thread: Option<String>,
    pub title: String,
    pub when: Option<String>,
    pub open: bool,
    pub pinned: bool,
    pub archived: bool,
    pub saving: bool,
}

/// The card's rows: the conversations in use, and the archived ones listed apart.
pub struct Rows {
    pub active: Vec<Row>,
    pub archived: Vec<Row>,
}

/// Ctrl+Shift+N on Windows and Linux, Cmd+Shift+N on macOS, as the reference's new-thread key.
pub fn is_new_conversation_shortcut(keystroke: &Keystroke) -> bool {
    let modifiers = &keystroke.modifiers;
    let command = if cfg!(target_os = "macos") { modifiers.platform } else { modifiers.control };
    keystroke.key == "n" && command && modifiers.shift && !modifiers.alt
}

/// The title the server would keep, or why it would refuse it.
fn valid_title(text: &str) -> Result<&str, &'static str> {
    let title = text.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX {
        return Err("Use 1 to 120 characters.");
    }
    Ok(title)
}

/// Pinned conversations first, each group newest first, as the reference orders its threads.
fn ordered(mut conversations: Vec<&BotConversation>) -> Vec<&BotConversation> {
    conversations.sort_by(|a, b| {
        b.pinned_at.is_some().cmp(&a.pinned_at.is_some()).then_with(|| b.created_at.cmp(&a.created_at))
    });
    conversations
}

impl Conversations {
    /// The conversation to show for `target`: the one this agent last had open, when the sidebar
    /// asks for the agent.
    pub fn resume(&self, target: Target) -> Target {
        match &target {
            Target::Agent(agent) => match self.current.get(agent) {
                Some(thread) => Target::Conversation { agent: agent.clone(), thread: thread.clone() },
                None => target,
            },
            _ => target,
        }
    }

    pub fn opened(&mut self, target: &Target) {
        if let Target::Conversation { agent, thread } = target {
            self.current.insert(agent.clone(), thread.clone());
        }
    }

    pub fn creating(&self, agent: &str) -> bool {
        self.creating.as_deref() == Some(agent)
    }

    pub fn saving(&self, thread: &str) -> bool {
        self.saving.contains(thread)
    }

    pub fn renaming(&self, thread: &str) -> Option<&Rename> {
        self.renaming.as_ref().filter(|rename| rename.thread == thread)
    }

    fn find(&self, agent: &str, thread: &str) -> Option<&BotConversation> {
        self.lists.get(agent)?.iter().find(|conversation| conversation.thread_id == thread)
    }

    /// Whether `target` is an archived conversation, which takes no new messages until restored.
    pub fn archived(&self, target: &Target) -> bool {
        match target {
            Target::Conversation { agent, thread } => {
                self.find(agent, thread).is_some_and(|conversation| conversation.archived_at.is_some())
            }
            _ => false,
        }
    }

    fn replace(&mut self, conversation: BotConversation) {
        let list = self.lists.entry(conversation.bot_id.clone()).or_default();
        match list.iter_mut().find(|listed| listed.thread_id == conversation.thread_id) {
            Some(listed) => *listed = conversation,
            None => list.insert(0, conversation),
        }
    }
}

impl Desktop {
    /// Starts another conversation with the open agent and opens it, keeping the others and
    /// their drafts; nothing is cleared or copied.
    pub fn new_conversation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let Some(agent) = self.chat.as_ref().and_then(|chat| chat.target.agent().map(str::to_owned)) else {
            return;
        };
        if self.conversations.creating.is_some() {
            return;
        }
        let (Some(api), Some(space)) = (self.api.clone(), self.space_id()) else { return };
        self.conversations.creating = Some(agent.clone());
        let bot = agent.clone();
        let work = async move { api.client.create_bot_conversation(&space, &bot).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            this.conversations.creating = None;
            match result {
                Ok(conversation) => {
                    let thread = conversation.thread_id.clone();
                    this.conversations.replace(conversation);
                    if this.view == super::View::Chat
                        && this.chat.as_ref().and_then(|chat| chat.target.agent()) == Some(agent.as_str())
                    {
                        this.open(Target::Conversation { agent, thread }, window, cx);
                    }
                }
                Err(error) => this.notify(api::explain(&error), true, None, cx),
            }
        });
        cx.notify();
    }

    /// Opens one of the agent's conversations: `None` is its first one.
    pub fn open_conversation(
        &mut self,
        agent: &str,
        thread: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = match thread {
            Some(thread) => Target::Conversation { agent: agent.to_owned(), thread },
            None => {
                self.conversations.current.remove(agent);
                Target::Agent(agent.to_owned())
            }
        };
        self.open(target, window, cx);
    }

    /// Reads the agent's conversations again after a change signal; the server sends each one's
    /// newest line with it.
    pub fn read_conversations(&mut self, agent: &str, generation: u64, window: &mut Window, cx: &mut Context<Self>) {
        let list = &self.conversations;
        if list.read.get(agent) == Some(&generation) || list.reading.contains(agent) {
            return;
        }
        let (Some(api), Some(space)) = (self.api.clone(), self.space_id()) else { return };
        self.conversations.reading.insert(agent.to_owned());
        let bot = agent.to_owned();
        let work = async move { api.client.bot_conversations(&space, &bot).await };
        let agent = agent.to_owned();
        self.call(window, cx, work, move |this, result, _, _| {
            let list = &mut this.conversations;
            list.reading.remove(&agent);
            list.read.insert(agent.clone(), generation);
            if let Ok(conversations) = result {
                list.lists.insert(agent, conversations);
            }
        });
    }

    /// The agent's conversations: pinned first, then newest first, its first conversation last.
    /// Archived ones are listed apart, except the open one, which stays where it is.
    pub fn conversation_rows(&self, agent: &str) -> Rows {
        let listed = self.conversations.lists.get(agent).map(|list| list.iter().collect()).unwrap_or_default();
        let open = self.chat.as_ref().map(|chat| &chat.target);
        let (now, zone) = (crate::clock::now(), chrono::Local);
        let mut rows = Rows { active: Vec::new(), archived: Vec::new() };
        for conversation in ordered(listed) {
            let target = Target::Conversation { agent: agent.to_owned(), thread: conversation.thread_id.clone() };
            let row = Row {
                open: open == Some(&target),
                thread: Some(conversation.thread_id.clone()),
                title: named(conversation).unwrap_or_else(|| "New conversation".into()),
                when: crate::clock::instant(&conversation.created_at).map(|at| crate::clock::stamp(at, now, &zone)),
                pinned: conversation.pinned_at.is_some(),
                archived: conversation.archived_at.is_some(),
                saving: self.conversations.saving.contains(&conversation.thread_id),
            };
            if row.archived && !row.open {
                rows.archived.push(row);
            } else {
                rows.active.push(row);
            }
        }
        let first = Target::Agent(agent.to_owned());
        let preview =
            self.agent(agent).map(|summary| summary.preview.trim().to_owned()).filter(|line| !line.is_empty());
        rows.active.push(Row {
            open: open == Some(&first),
            thread: None,
            title: preview.unwrap_or_else(|| "First conversation".into()),
            when: None,
            pinned: false,
            archived: false,
            saving: false,
        });
        rows
    }

    /// What one of the agent's conversations read so far is called, by its title or newest line.
    pub fn conversation_name(&self, agent: &str, thread: &str) -> Option<String> {
        let listed = self.conversations.lists.get(agent)?;
        listed.iter().find(|conversation| conversation.thread_id == thread).and_then(named)
    }

    /// Opens the actions of one of the agent's conversations where the pointer is.
    pub fn open_conversation_menu(&mut self, agent: &str, thread: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        let kind = MenuKind::Conversation { agent: agent.to_owned(), thread: thread.to_owned() };
        self.menu = match &self.menu {
            Some(menu) if menu.kind == kind => None,
            _ => Some(Menu { kind, at }),
        };
        cx.notify();
    }

    /// Saves a change to one conversation's title, pin or archive.
    pub fn change_conversation(
        &mut self,
        agent: &str,
        thread: &str,
        patch: BotConversationPatch<'static>,
        title: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.menu = None;
        let (Some(api), Some(space)) = (self.api.as_ref(), self.space_id()) else { return };
        if !self.conversations.saving.insert(thread.to_owned()) {
            return;
        }
        self.conversations.problem = None;
        let features = Features::new(api.client.clone());
        let (bot, id) = (agent.to_owned(), thread.to_owned());
        let work = async move {
            let patch = BotConversationPatch { title: title.as_deref(), ..patch };
            features.space(space).update_bot_conversation(&bot, &id, patch).await
        };
        let thread = thread.to_owned();
        self.call(window, cx, work, move |this, result, _, cx| {
            this.conversations.saving.remove(&thread);
            match result {
                Ok(conversation) => {
                    if this.conversations.renaming(&thread).is_some() {
                        this.conversations.renaming = None;
                    }
                    this.conversations.replace(conversation);
                }
                Err(error) => {
                    let problem = api::explain(&error);
                    match this.conversations.renaming.as_mut().filter(|rename| rename.thread == thread) {
                        Some(rename) => rename.problem = Some(problem),
                        None => this.conversations.problem = Some(problem),
                    }
                }
            }
            cx.notify();
        });
        cx.notify();
    }

    /// Edits a conversation's title in its row: Enter saves, Escape leaves it as it was.
    pub fn rename_conversation(&mut self, agent: &str, thread: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let current = self.conversations.find(agent, thread).and_then(|conversation| conversation.title.clone());
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Conversation name").default_value(current.unwrap_or_default())
        });
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        let (agent_id, thread_id) = (agent.to_owned(), thread.to_owned());
        let events = cx.subscribe_in(&input, window, move |this, input, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => {
                let text = input.read(cx).value().to_string();
                match valid_title(&text) {
                    Ok(title) => {
                        let title = title.to_owned();
                        this.change_conversation(
                            &agent_id,
                            &thread_id,
                            BotConversationPatch::default(),
                            Some(title),
                            window,
                            cx,
                        );
                    }
                    Err(problem) => {
                        if let Some(rename) = this.conversations.renaming.as_mut() {
                            rename.problem = Some(problem.into());
                        }
                        cx.notify();
                    }
                }
            }
            InputEvent::Blur => {
                if !this.conversations.saving.contains(&thread_id) {
                    this.conversations.renaming = None;
                    cx.notify();
                }
            }
            _ => {}
        });
        self.conversations.renaming = Some(Rename { thread: thread.to_owned(), input, problem: None, _events: events });
        cx.notify();
    }

    pub fn cancel_rename(&mut self, cx: &mut Context<Self>) -> bool {
        if self.conversations.renaming.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    /// Whether the open conversation is archived, so it takes no new message until restored.
    pub fn open_conversation_archived(&self) -> bool {
        self.chat.as_ref().is_some_and(|chat| self.conversations.archived(&chat.target))
    }

    /// Restores the open conversation so it takes messages again.
    pub fn restore_open_conversation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Target::Conversation { agent, thread }) = self.chat.as_ref().map(|chat| chat.target.clone()) else {
            return;
        };
        let patch = BotConversationPatch { archived: Some(false), ..Default::default() };
        self.change_conversation(&agent, &thread, patch, None, window, cx);
    }
}

fn named(conversation: &BotConversation) -> Option<String> {
    conversation.title.clone().or_else(|| conversation.preview.clone()).filter(|title| !title.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use gpui_kit::{Keystroke, Modifiers};
    use superbot_features::BotConversation;

    use super::{is_new_conversation_shortcut, ordered, valid_title, Conversations};
    use crate::api::Target;

    fn conversation(agent: &str, thread: &str) -> Target {
        Target::Conversation { agent: agent.into(), thread: thread.into() }
    }

    fn listed(thread: &str, created: &str, pinned: bool, archived: bool) -> BotConversation {
        BotConversation {
            thread_id: thread.into(),
            bot_id: "bot-1".into(),
            created_at: created.into(),
            title: None,
            pinned_at: pinned.then(|| "2026-11-20T10:00:00Z".into()),
            archived_at: archived.then(|| "2026-11-20T10:00:00Z".into()),
            preview: None,
        }
    }

    #[test]
    fn another_conversation_names_its_thread_and_keeps_its_own_local_turn() {
        let other = conversation("bot-1", "thread-2");
        assert_eq!(
            serde_json::to_value(other.wire()).unwrap(),
            serde_json::json!({ "botId": "bot-1", "threadId": "thread-2" })
        );
        assert_eq!(
            serde_json::to_value(Target::Agent("bot-1".into()).wire()).unwrap(),
            serde_json::json!({ "botId": "bot-1" })
        );
        assert_eq!(other.agent(), Some("bot-1"));
        assert_eq!(other.local_key().as_deref(), Some("thread:thread-2"));
        assert_eq!(Target::Agent("bot-1".into()).local_key().as_deref(), Some("bot-1"));
        assert_eq!(Target::Group("g".into()).local_key(), None);
    }

    #[test]
    fn an_agent_returns_to_the_conversation_it_last_had_open() {
        let mut conversations = Conversations::default();
        let first = Target::Agent("bot-1".into());
        assert_eq!(conversations.resume(first.clone()), first);
        conversations.opened(&conversation("bot-1", "thread-2"));
        assert_eq!(conversations.resume(first.clone()), conversation("bot-1", "thread-2"));
        assert_eq!(conversations.resume(Target::Agent("bot-3".into())), Target::Agent("bot-3".into()));
        conversations.current.remove("bot-1");
        assert_eq!(conversations.resume(first.clone()), first);
    }

    #[test]
    fn pinned_conversations_come_first_then_the_newest() {
        let list = [
            listed("old", "2026-11-18T10:00:00Z", false, false),
            listed("new", "2026-11-20T10:00:00Z", false, false),
            listed("pinned", "2026-11-17T10:00:00Z", true, false),
        ];
        let order: Vec<&str> = ordered(list.iter().collect()).iter().map(|c| c.thread_id.as_str()).collect();
        assert_eq!(order, ["pinned", "new", "old"]);
    }

    #[test]
    fn an_archived_conversation_takes_no_new_message() {
        let mut conversations = Conversations::default();
        conversations.replace(listed("thread-2", "2026-11-20T10:00:00Z", false, true));
        assert!(conversations.archived(&conversation("bot-1", "thread-2")));
        assert!(!conversations.archived(&Target::Agent("bot-1".into())));
        conversations.replace(listed("thread-2", "2026-11-20T10:00:00Z", false, false));
        assert!(!conversations.archived(&conversation("bot-1", "thread-2")));
    }

    #[test]
    fn a_title_needs_one_to_a_hundred_and_twenty_characters() {
        assert_eq!(valid_title("  Launch plan "), Ok("Launch plan"));
        assert!(valid_title("   ").is_err());
        assert!(valid_title(&"x".repeat(121)).is_err());
        assert!(valid_title(&"é".repeat(120)).is_ok());
    }

    #[test]
    fn the_new_conversation_key_needs_shift() {
        let key = |shift: bool| Keystroke {
            modifiers: Modifiers {
                control: !cfg!(target_os = "macos"),
                platform: cfg!(target_os = "macos"),
                shift,
                ..Default::default()
            },
            key: "n".into(),
            key_char: None,
        };
        assert!(is_new_conversation_shortcut(&key(true)));
        assert!(!is_new_conversation_shortcut(&key(false)));
    }
}
