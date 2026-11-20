//! The open conversation: reading it and following it live, older history, attaching and
//! sending, naming a group's bots, and fetching the files messages carry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gpui_kit::*;
use serde_json::Value;
mod events;
use events::apply_event;
use superbot_features::local_cli::{run_local_model, InstalledModel, LocalCli, PendingHistory};

use super::{Desktop, View};
use crate::api::{self, GroupMember, Outgoing, Target};
use crate::files::{self, Picked, Refused};
use crate::outbox::{self, Draft, MentionQuery, Outbox, Place};
use crate::runtime::{follow, network, Live};
use crate::transcript::{prepend, Entry, FileRef, Part, Speaker, MOST_ENTRIES};

#[derive(Clone)]
pub(crate) struct LocalWrite {
    payload: PendingHistory,
    pub(crate) saving: bool,
    pub(crate) problem: Option<String>,
}

impl LocalWrite {
    fn new(text: String, reply: Option<String>) -> Self {
        Self::from(PendingHistory { id: uuid::Uuid::new_v4().to_string(), text, reply })
    }

    /// The message and the local model's reply, as they will be saved.
    pub(crate) fn exchange(&self) -> (&str, Option<&str>) {
        (&self.payload.text, self.payload.reply.as_deref())
    }
}

impl From<PendingHistory> for LocalWrite {
    fn from(payload: PendingHistory) -> Self {
        Self { payload, saving: false, problem: Some("Local message is waiting to be saved.".into()) }
    }
}

pub struct Chat {
    pub target: Target,
    pub entries: Vec<Entry>,
    pub loading: bool,
    pub working: bool,
    /// What the agent says it is doing right now.
    pub activity: Option<String>,
    /// The reply as it is being written.
    pub draft: String,
    pub error: Option<String>,
    /// The conversation itself could not be read, so there is nothing to show but a retry.
    pub unread: bool,
    pub reconnecting: bool,
    pub list: ListState,
    /// Older history, what is being sent, mentions and fetched files.
    pub conversation: Conversation,
    /// Its question cards: which runs wait for an answer, and what is typed or sent.
    pub cards: crate::cards::Cards,
    _live: Option<Task<()>>,
    pub(crate) local_turn: Option<Task<()>>,
    /// The message the local model is answering, shown in the transcript until its reply comes.
    pub(crate) local_prompt: Option<String>,
    /// A message an Inbox line asked to show, and its mark once shown.
    pub reveal: super::reveal::Reveal,
    /// Local-model help with the bot's apps, open beside this conversation.
    pub app_assist: crate::ui::app_assist::AppAssist,
}

impl Chat {
    /// The transcript's rows: one for the history before what is loaded, every message, then
    /// one for what is happening now.
    pub fn rows(&self) -> usize {
        self.entries.len() + 2
    }

    /// The list row a message is drawn in.
    pub(crate) fn row_of(entry: usize) -> usize {
        entry + 1
    }
}

/// What is happening to a stored file the person asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileState {
    Fetching,
    Problem(String),
}

pub struct Conversation {
    /// Where the page before the oldest message on screen starts; None at the beginning.
    pub older: Option<u64>,
    pub loading_older: bool,
    pub older_problem: Option<String>,
    /// The transcript holds as much as it keeps in memory; what is older stays on the server.
    pub capped: bool,
    /// A group's bots, for mentions.
    pub members: Vec<GroupMember>,
    pub outbox: Outbox,
    /// The row of the mention list the keyboard is on.
    pub mention_choice: usize,
    /// The mention the person closed the list on, until they type on.
    pub mention_closed: Option<MentionQuery>,
    pub files: HashMap<String, FileState>,
}

impl Conversation {
    pub fn new() -> Self {
        Self {
            older: None,
            loading_older: false,
            older_problem: None,
            capped: false,
            members: Vec::new(),
            outbox: new_outbox(),
            mention_choice: 0,
            mention_closed: None,
            files: HashMap::new(),
        }
    }
}

fn new_outbox() -> Outbox {
    let moment =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
    Outbox::new(format!("desktop-{}-{moment}", std::process::id()))
}

/// The open `@` list: the mention being typed, the bots it could mean, and the caret.
pub struct MentionList {
    pub query: MentionQuery,
    pub caret: usize,
    pub choices: Vec<GroupMember>,
    pub chosen: usize,
}

/// How near the top of what is loaded the view comes before the page before it is read.
const NEAR_TOP: usize = 3;

/// The most files one visit to the file chooser can add; the message's own limit is lower.
const MOST_PICKED: usize = 32;

impl Desktop {
    pub fn open(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.conversations.resume(target);
        self.conversations.opened(&target);
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        self.view = View::Chat;
        self.set_workspace_visible(false, window, cx);
        self.menu = None;
        if self.chat.as_ref().is_some_and(|chat| chat.target == target) {
            cx.notify();
            return;
        }
        self.keep_draft(window, cx);
        self.composer.update(cx, |composer, cx| composer.focus(window, cx));
        self.chat = Some(Chat {
            target: target.clone(),
            entries: Vec::new(),
            loading: true,
            working: false,
            activity: None,
            draft: String::new(),
            error: None,
            unread: false,
            reconnecting: false,
            list: transcript_list(),
            conversation: Conversation::new(),
            cards: crate::cards::Cards::default(),
            _live: None,
            local_turn: None,
            local_prompt: None,
            reveal: Default::default(),
            app_assist: Default::default(),
        });
        self.resume_draft(window, cx);
        self.restore_local_write();
        let read = target.clone();
        let selection = self.space_selection;
        let work = async move {
            let snapshot = api.snapshot(&space_id, &read).await?;
            api.mark_read(&space_id, &read).await.ok();
            Ok(snapshot)
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            if this.space_selection != selection {
                return;
            }
            let Some(chat) = this.chat.as_mut().filter(|chat| chat.target == target) else { return };
            chat.loading = false;
            match result {
                Ok(snapshot) => {
                    chat.working = snapshot.working();
                    chat.cards.read(&snapshot);
                    let cursor = snapshot.cursor;
                    chat.conversation.older = snapshot.older_cursor;
                    chat.conversation.members = snapshot.members.unwrap_or_default();
                    chat.entries = snapshot.messages.into_iter().filter_map(Entry::read).collect();
                    chat.list.reset(chat.rows());
                    this.follow(target, cursor, cx);
                    this.reload_space(cx);
                }
                Err(error) => {
                    chat.unread = true;
                    chat.error = Some(api::explain(&error));
                }
            }
            this.seek_reveal(window, cx);
        });
        cx.notify();
    }

    fn follow(&mut self, target: Target, cursor: i64, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let selection = self.space_selection;
        let mut live = follow(api.client, space_id.clone(), target.clone(), cursor);
        let task = cx.spawn(async move |this, cx| {
            while let Some(update) = live.recv().await {
                let applied = this.update(cx, |this, cx| {
                    let open = this.active_space(selection, &space_id)
                        && this.chat.as_ref().is_some_and(|chat| chat.target == target);
                    if open {
                        this.apply_live(update, cx);
                    }
                    open
                });
                if !matches!(applied, Ok(true)) {
                    break;
                }
            }
        });
        if let Some(chat) = self.chat.as_mut() {
            chat._live = Some(task);
        }
    }

    fn apply_live(&mut self, update: Live, cx: &mut Context<Self>) {
        let Some(chat) = self.chat.as_mut() else { return };
        match update {
            Live::Connected => chat.reconnecting = false,
            Live::Reconnecting => chat.reconnecting = true,
            Live::Unauthorized => {
                chat.error = Some("Your session ended. Sign in again.".into());
            }
            Live::Event(event) => {
                if apply_event(chat, &event) {
                    self.read_open_conversation(cx);
                }
            }
        }
        cx.notify();
    }

    pub fn stop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut().filter(|chat| chat.local_turn.is_some()) {
            chat.local_turn = None;
            self.restore_local_prompt(window, cx);
            cx.notify();
            return;
        }
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(target) = self.chat.as_ref().map(|chat| chat.target.clone()) else { return };
        let work = async move { api.stop(&space_id, &target).await };
        self.call(window, cx, work, |this, result, _, cx| {
            if let Err(error) = result {
                this.notify(api::explain(&error), true, None, cx);
            }
        });
    }

    pub fn answer_card(
        &mut self,
        run_id: String,
        message_id: String,
        answer: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(target) = self.chat.as_ref().map(|chat| chat.target.clone()) else { return };
        let work = async move { api.answer_card(&space_id, &target, &run_id, &message_id, &answer).await };
        self.call(window, cx, work, |this, result, _, cx| {
            if let Err(error) = result {
                this.notify(api::explain(&error), true, None, cx);
            }
        });
    }
}

impl Desktop {
    pub fn max_upload_bytes(&self) -> u64 {
        self.me.as_ref().and_then(|me| me.max_upload_size_bytes).unwrap_or(files::DEFAULT_MAX_BYTES)
    }

    pub fn max_attachments(&self) -> usize {
        self.me.as_ref().and_then(|me| me.max_attachments_per_message).unwrap_or(files::DEFAULT_MAX_COUNT)
    }

    fn place(&self) -> Option<Place> {
        Some((self.space_id()?, self.chat.as_ref()?.target.clone()))
    }

    /// The outbox of a conversation, whether it is on screen or kept as a draft.
    fn outbox_at(&mut self, place: &Place) -> Option<&mut Outbox> {
        if self.place().as_ref() == Some(place) {
            return self.chat.as_mut().map(|chat| &mut chat.conversation.outbox);
        }
        self.drafts.get_mut(place).map(|draft| &mut draft.outbox)
    }

    /// Sets aside what is typed and attached before another conversation takes the composer.
    pub fn keep_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(place) = self.place() else { return };
        self.restore_local_prompt(window, cx);
        let Some(chat) = self.chat.as_mut() else { return };
        let text = self.composer.read(cx).value().to_string();
        let outbox = std::mem::replace(&mut chat.conversation.outbox, new_outbox());
        self.drafts.keep(place, Draft { text, outbox });
        self.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
    }

    /// Brings back what was typed and attached in the conversation that has just opened, and
    /// follows its scrolling so older history loads as the person reaches it.
    pub fn resume_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(place) = self.place() else { return };
        let draft = self.drafts.take(&place);
        let Some(chat) = self.chat.as_mut() else { return };
        if let Some(draft) = draft {
            chat.conversation.outbox = draft.outbox;
            self.composer.update(cx, |composer, cx| composer.set_value(draft.text, window, cx));
        }
        let this = cx.entity().downgrade();
        chat.list.set_scroll_handler(move |event, window, cx| {
            if event.visible_range.start > NEAR_TOP {
                return;
            }
            // GPUI 0.3.12 calls this handler while the list's state is borrowed, and loading
            // older history reads and changes that state, so it waits for the scroll to finish.
            let this = this.clone();
            window.defer(cx, move |window, cx| {
                this.update(cx, |this, cx| this.load_older(window, cx)).ok();
            });
        });
    }

    /// Reads the page of history before the oldest message on screen and puts it above, leaving
    /// what the person is looking at where it is.
    pub fn load_older(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(chat) = self.chat.as_mut() else { return };
        let Some(before) = chat.conversation.older else { return };
        if chat.loading || chat.conversation.loading_older {
            return;
        }
        chat.conversation.loading_older = true;
        chat.conversation.older_problem = None;
        chat.list.remeasure_items(0..1);
        let target = chat.target.clone();
        let read = target.clone();
        let work = async move { api.older(&space_id, &read, before).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(chat) = this.chat.as_mut().filter(|chat| chat.target == target) else { return };
            let state = &mut chat.conversation;
            if !state.loading_older || state.older != Some(before) {
                return;
            }
            state.loading_older = false;
            match result {
                Ok(page) => {
                    let top = chat.list.logical_scroll_top();
                    let read = page.messages.len();
                    let older: Vec<Entry> = page.messages.into_iter().filter_map(Entry::read).collect();
                    let shown = older.len();
                    let added = prepend(&mut chat.entries, older);
                    state.capped = added < shown || chat.entries.len() >= MOST_ENTRIES;
                    // A page that brings nothing back ends the history, whatever cursor it names.
                    state.older = page.older_cursor.filter(|next| !state.capped && read > 0 && *next < before);
                    chat.list.splice(1..1, added);
                    // The head row changed, and the row that was first now has a neighbour above.
                    chat.list.remeasure_items(0..1);
                    chat.list.remeasure_items(added + 1..added + 2);
                    if top.item_ix == 0 {
                        // The view was on the head row itself, which the list does not move with
                        // the rows put after it; keep the message that was first at the top.
                        chat.list.scroll_to(ListOffset { item_ix: added + 1, offset_in_item: px(0.) });
                    }
                }
                Err(error) => {
                    state.older_problem = Some(api::explain(&error));
                    chat.list.remeasure_items(0..1);
                }
            }
            this.seek_reveal(window, cx);
        });
        cx.notify();
    }

    /// Opens the system's file chooser and attaches what it returns to the conversation that
    /// was on screen when it opened.
    pub fn attach_files(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let Some(place) = self.place() else { return };
        let most = self.max_attachments();
        let limit = self.max_upload_bytes();
        let Some(outbox) = self.outbox_at(&place) else { return };
        if outbox.sending {
            return;
        }
        if outbox.attachments.len() >= most {
            outbox.problem = Some(full_message(most));
            cx.notify();
            return;
        }
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else { return };
            let checked = cx
                .background_executor()
                .spawn(async move {
                    paths.iter().take(MOST_PICKED).map(|path| files::inspect(path, limit)).collect::<Vec<_>>()
                })
                .await;
            this.update(cx, |this, cx| {
                this.attach_checked(&place, checked, most);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn attach_checked(&mut self, place: &Place, checked: Vec<Result<Picked, Refused>>, most: usize) {
        let Some(outbox) = self.outbox_at(place) else { return };
        let mut problems: Vec<String> = Vec::new();
        let mut left_out = false;
        for file in checked {
            match file {
                Ok(picked) => {
                    let full = outbox.attachments.len() >= most;
                    left_out |= !outbox.attach(picked, most) && full;
                }
                Err(refused) => problems.push(refused.sentence()),
            }
        }
        if left_out {
            problems.push(full_message(most));
        }
        problems.truncate(3);
        outbox.problem = (!problems.is_empty()).then(|| problems.join(" "));
    }

    pub fn detach_file(&mut self, id: u64, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.conversation.outbox.detach(id);
            chat.conversation.outbox.problem = None;
            cx.notify();
        }
    }

    /// Sends what the composer holds: stores each attached file, then the message. The words
    /// and the files stay in the composer until the server takes the message; if it does not,
    /// they are still there to send again.
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open_conversation_archived() {
            return;
        }
        if self.place().is_some_and(|place| self.local_writes.contains_key(&place)) {
            self.retry_local_write(window, cx);
            return;
        }
        if self.take_apps_command(window, cx) {
            return;
        }
        match self.local_model_selection() {
            Ok(Some(model)) => {
                self.start_local_turn(model, window, cx);
                return;
            }
            Err(problem) => {
                if let Some(chat) = self.chat.as_mut() {
                    chat.error = Some(problem.into());
                    cx.notify();
                }
                return;
            }
            Ok(None) => {}
        }
        let (Some(api), Some(place)) = (self.api.clone(), self.place()) else { return };
        let text = self.composer.read(cx).value().to_string();
        let limit = self.max_upload_bytes();
        let Some(chat) = self.chat.as_mut() else { return };
        if chat.loading {
            return;
        }
        let mentions = match chat.target {
            Target::Group(_) => outbox::mentioned(&text, &chat.conversation.members),
            Target::Agent(_) | Target::Conversation { .. } => Vec::new(),
        };
        let Some(sending) = chat.conversation.outbox.begin(&text, mentions) else { return };
        chat.error = None;
        chat.conversation.mention_closed = None;
        // Sending brings the person back to the latest message.
        chat.list.set_follow_mode(FollowMode::Tail);

        let stored = Arc::new(Mutex::new(Vec::<(u64, String)>::new()));
        let (progress, sent_text, at) = (stored.clone(), sending.text.clone(), place.clone());
        let work = async move {
            let (space_id, target) = &at;
            let mut artifact_ids = Vec::new();
            for upload in sending.uploads {
                let artifact_id = match upload.artifact_id {
                    Some(artifact_id) => artifact_id,
                    None => {
                        let path = upload.path.clone();
                        let read = tokio::task::spawn_blocking(move || files::read_base64(&path, limit)).await;
                        let content = match read {
                            Ok(Ok(content)) => content,
                            Ok(Err(refused)) => return Ok(Err(refused.sentence())),
                            Err(_) => return Ok(Err(Refused::Unreadable(upload.name).sentence())),
                        };
                        let artifact_id = api
                            .upload(space_id, target, &upload.name, upload.mime_type, &content, &upload.nonce)
                            .await?;
                        if let Ok(mut progress) = progress.lock() {
                            progress.push((upload.id, artifact_id.clone()));
                        }
                        artifact_id
                    }
                };
                artifact_ids.push(artifact_id);
            }
            let message = Outgoing {
                text: Some(&sending.text),
                artifact_ids: &artifact_ids,
                mentions: &sending.mentions,
                nonce: &sending.nonce,
            };
            api.send(space_id, target, &message).await.map(Ok)
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let on_screen = this.place().as_ref() == Some(&place);
            let uploaded = stored.lock().map(|stored| stored.clone()).unwrap_or_default();
            let Some(outbox) = this.outbox_at(&place) else { return };
            for (id, artifact_id) in uploaded {
                outbox.stored(id, artifact_id);
            }
            match result {
                Ok(Ok(())) => {
                    outbox.acknowledged();
                    if on_screen {
                        // Only what was sent leaves the composer.
                        if this.composer.read(cx).value().trim() == sent_text {
                            this.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
                        }
                    } else if let Some(draft) = this.drafts.get_mut(&place) {
                        if draft.text.trim() == sent_text {
                            draft.text.clear();
                        }
                    }
                }
                Ok(Err(unreadable)) => outbox.failed(unreadable),
                Err(error) => outbox.failed(api::explain(&error)),
            }
        });
        cx.notify();
    }

    pub(crate) fn local_cli(&self) -> Option<LocalCli> {
        LocalCli::for_workspace(self.api.as_ref()?.client.server(), &self.me.as_ref()?.user_id, &self.space_id()?)
    }

    fn local_model_selection(&self) -> Result<Option<InstalledModel>, &'static str> {
        let (Some(cli), Some(chat)) = (self.local_cli(), self.chat.as_ref()) else { return Ok(None) };
        let Some(bot) = chat.target.agent() else { return Ok(None) };
        cli.selection(bot)
    }

    pub(crate) fn selected_local_model(&self) -> Option<InstalledModel> {
        self.local_model_selection().ok().flatten()
    }

    pub(crate) fn pending_local_write(&self) -> Option<&LocalWrite> {
        self.local_writes.get(&self.place()?)
    }

    fn restore_local_write(&mut self) {
        let (Some(cli), Some(place)) = (self.local_cli(), self.place()) else { return };
        if self.local_writes.contains_key(&place) {
            return;
        }
        let Some(key) = place.1.local_key() else { return };
        match cli.pending_history(&key) {
            Ok(Some(pending)) => {
                self.local_writes.insert(place, pending.into());
            }
            Ok(None) => {}
            Err(problem) => {
                if let Some(chat) = self.chat.as_mut() {
                    chat.error = Some(problem.into());
                }
            }
        }
    }

    pub(crate) fn send_local_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((place, text)) = self.local_input(cx) else { return };
        self.local_writes.insert(place, LocalWrite::new(text, None));
        self.retry_local_write(window, cx);
    }

    fn local_input(&self, cx: &App) -> Option<(Place, String)> {
        let place = self.place()?;
        let chat = self.chat.as_ref()?;
        let outbox = &chat.conversation.outbox;
        if chat.loading
            || self.conversations.archived(&chat.target)
            || chat.local_turn.is_some()
            || self.local_writes.contains_key(&place)
            || outbox.sending
            || !outbox.attachments.is_empty()
        {
            return None;
        }
        let text = self.composer.read(cx).value().trim().to_owned();
        (!text.is_empty()).then_some((place, text))
    }

    fn start_local_turn(&mut self, model: InstalledModel, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cli) = self.local_cli() else { return };
        let Some((place, text)) = self.local_input(cx) else { return };
        let (Some(api), Some(agent)) = (self.api.as_ref(), place.1.agent()) else { return };
        let features = superbot_features::Features::new(api.client.clone());
        let space = place.0.clone();
        let agent = agent.to_owned();
        let Some(chat) = self.chat.as_mut() else { return };
        let history = chat.entries.iter().rev().take(40).rev().filter_map(|entry| {
            let Part::Text(body) = entry.parts.first()? else { return None };
            let role = match entry.speaker {
                Speaker::Person => "user",
                Speaker::Agent => "assistant",
                Speaker::System => return None,
            };
            Some(serde_json::json!({ "role": role, "content": body }))
        });
        let prompt = if chat.entries.is_empty() {
            text.clone()
        } else {
            let messages: Vec<_> = history.chain([serde_json::json!({ "role": "user", "content": text })]).collect();
            format!("Continue the conversation. Reply to the final user message.\n{}", Value::Array(messages))
        };
        chat.error = None;
        chat.list.set_follow_mode(FollowMode::Tail);
        chat.local_prompt = Some(text.clone());
        chat.local_turn = Some(cx.spawn_in(window, async move |this, cx| {
            let result = network(async move {
                let prompt = features.space(space).local_chat_prompt(&agent, prompt).await?;
                Ok(run_local_model(&cli, &model, &prompt).await)
            })
            .await;
            this.update_in(cx, |this, window, cx| {
                if this.place().as_ref() != Some(&place) {
                    return;
                }
                let Some(chat) = this.chat.as_mut() else { return };
                chat.local_turn = None;
                match result {
                    Ok(Ok(reply)) => {
                        chat.local_prompt = None;
                        this.local_writes.insert(place, LocalWrite::new(text, Some(reply)));
                        this.retry_local_write(window, cx);
                    }
                    Ok(Err(problem)) => {
                        chat.error = Some(problem);
                        this.restore_local_prompt(window, cx);
                    }
                    Err(error) => {
                        chat.error = Some(error.to_string());
                        this.restore_local_prompt(window, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        self.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
        cx.notify();
    }

    /// Puts a local turn's message back in the composer when its reply never came, ahead of
    /// anything typed since.
    fn restore_local_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.chat.as_mut().and_then(|chat| chat.local_prompt.take()) else { return };
        let typed = self.composer.read(cx).value().trim().to_owned();
        let restored = if typed.is_empty() { text } else { format!("{text}\n\n{typed}") };
        self.composer.update(cx, |composer, cx| composer.set_value(restored, window, cx));
    }

    fn retry_local_write(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(place), Some(cli)) = (self.api.clone(), self.place(), self.local_cli()) else { return };
        let Some(key) = place.1.local_key() else { return };
        let Some(write) = self.local_writes.get_mut(&place).filter(|write| !write.saving) else { return };
        if let Err(problem) = cli.stage_history(&key, &write.payload) {
            write.problem = Some(problem.into());
            cx.notify();
            return;
        }
        write.saving = true;
        let payload = write.payload.clone();
        let at = place.clone();
        let account = self.me.as_ref().map(|me| me.user_id.clone());
        let work = async move {
            let (space, target) = &at;
            match payload.reply.as_deref() {
                Some(reply) => {
                    api.client.append_local_turn(space, target.wire(), &payload.id, &payload.text, reply).await
                }
                None => api.client.append_local_note(space, target.wire(), &payload.id, &payload.text).await,
            }
        };
        let id = write.payload.id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = network(work).await;
            this.update_in(cx, |this, window, cx| {
                if this.me.as_ref().map(|me| &me.user_id) != account.as_ref() {
                    return;
                }
                let visible = this.place().as_ref() == Some(&place);
                let Some(write) = this.local_writes.get_mut(&place).filter(|write| write.payload.id == id) else {
                    return;
                };
                write.saving = false;
                if let Err(error) = result {
                    write.problem = Some(api::explain(&error));
                } else {
                    let Some(key) = place.1.local_key() else { return };
                    if let Err(problem) = cli.clear_history(&key, &write.payload) {
                        write.problem = Some(problem.into());
                        if visible {
                            cx.notify();
                        }
                        return;
                    }
                    let text = write.payload.text.clone();
                    this.local_writes.remove(&place);
                    if this.place().as_ref() == Some(&place) {
                        if this.composer.read(cx).value().trim() == text {
                            this.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
                        }
                        if let Some(chat) = this.chat.as_mut() {
                            chat.list.set_follow_mode(FollowMode::Tail);
                        }
                    } else if let Some(draft) = this.drafts.get_mut(&place) {
                        if draft.text.trim() == text {
                            draft.text.clear();
                        }
                    }
                }
                if visible {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// The `@` list for the open group, when the caret sits in a mention that could still
    /// mean one of its bots.
    pub fn mention_list(&self, cx: &App) -> Option<MentionList> {
        let chat = self.chat.as_ref()?;
        let state = &chat.conversation;
        if !matches!(chat.target, Target::Group(_)) || state.outbox.sending {
            return None;
        }
        let composer = self.composer.read(cx);
        let (text, caret) = (composer.value(), composer.cursor());
        let query = outbox::mention_query(&text, caret)?;
        if state.mention_closed.as_ref() == Some(&query) {
            return None;
        }
        let choices: Vec<GroupMember> =
            outbox::mention_matches(&state.members, &query.typed).into_iter().cloned().collect();
        if choices.is_empty() {
            return None;
        }
        let chosen = state.mention_choice.min(choices.len() - 1);
        Some(MentionList { query, caret, choices, chosen })
    }

    /// Moves the keyboard's place in the `@` list. False when the list is not open.
    pub fn move_mention(&mut self, down: bool, cx: &mut Context<Self>) -> bool {
        let Some(list) = self.mention_list(cx) else { return false };
        let count = list.choices.len();
        let next = if down { (list.chosen + 1) % count } else { (list.chosen + count - 1) % count };
        if let Some(chat) = self.chat.as_mut() {
            chat.conversation.mention_choice = next;
        }
        cx.notify();
        true
    }

    /// Completes the mention being typed with the bot at `index`, or with the one the keyboard
    /// is on. False when the list is not open.
    pub fn pick_mention(&mut self, index: Option<usize>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(list) = self.mention_list(cx) else { return false };
        let Some(member) = list.choices.get(index.unwrap_or(list.chosen)) else { return false };
        let text = self.composer.read(cx).value().to_string();
        let (completed, caret) = outbox::complete_mention(&text, &list.query, list.caret, &member.name);
        self.composer.update(cx, |composer, cx| {
            composer.set_value(completed, window, cx);
            composer.set_selected_range(caret..caret, cx);
            composer.focus(window, cx);
        });
        if let Some(chat) = self.chat.as_mut() {
            chat.conversation.mention_choice = 0;
            chat.conversation.mention_closed = None;
        }
        cx.notify();
        true
    }

    /// Closes the `@` list until the person types on. False when it is not open.
    pub fn close_mention(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(list) = self.mention_list(cx) else { return false };
        if let Some(chat) = self.chat.as_mut() {
            chat.conversation.mention_closed = Some(list.query);
        }
        cx.notify();
        true
    }

    /// Fetches a file a message carries and either opens a copy of it in the system's viewer
    /// or asks where to save it. It is read through the conversation it was sent in.
    pub fn fetch_file(&mut self, file: FileRef, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(place)) = (self.api.clone(), self.place()) else { return };
        let Some(chat) = self.chat.as_mut() else { return };
        let files = &mut chat.conversation.files;
        if files.get(&file.artifact_id) == Some(&FileState::Fetching) {
            return;
        }
        if file.size.is_some_and(|size| size > files::LARGEST_DOWNLOAD) {
            let problem = format!("{} is too large to fetch here. Open it on the web.", file.name);
            files.insert(file.artifact_id, FileState::Problem(problem));
            cx.notify();
            return;
        }
        files.insert(file.artifact_id.clone(), FileState::Fetching);
        let (at, artifact_id) = (place.clone(), file.artifact_id.clone());
        let work = async move { api.file(&at.0, &at.1, &artifact_id).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let content = match result {
                Ok(content) => content,
                Err(error) => return this.file_done(&place, &file.artifact_id, Some(api::explain(&error))),
            };
            let Some(bytes) = files::decode(&content.content_base64) else {
                let problem = format!("{} couldn't be read. Try again.", file.name);
                return this.file_done(&place, &file.artifact_id, Some(problem));
            };
            match files::opens_as(&content.mime_type).filter(|_| open) {
                Some(extension) => this.open_copy(place, file, bytes, extension, cx),
                None => this.save_copy(place, file, content.name, bytes, window, cx),
            }
        });
        cx.notify();
    }

    fn file_done(&mut self, place: &Place, artifact_id: &str, problem: Option<String>) {
        if self.place().as_ref() != Some(place) {
            return;
        }
        let Some(chat) = self.chat.as_mut() else { return };
        match problem {
            Some(problem) => chat.conversation.files.insert(artifact_id.to_owned(), FileState::Problem(problem)),
            None => chat.conversation.files.remove(artifact_id),
        };
    }

    fn open_copy(
        &mut self,
        place: Place,
        file: FileRef,
        bytes: Vec<u8>,
        extension: &'static str,
        cx: &mut Context<Self>,
    ) {
        let path = files::open_copy_path(&file.artifact_id, &file.name, extension);
        cx.spawn(async move |this, cx| {
            let copy = path.clone();
            let written = cx
                .background_executor()
                .spawn(async move {
                    std::fs::create_dir_all(copy.parent().unwrap_or(&copy))?;
                    std::fs::write(&copy, bytes)
                })
                .await;
            this.update(cx, |this, cx| {
                let problem = match written {
                    Ok(()) => {
                        cx.open_with_system(&path);
                        None
                    }
                    Err(_) => Some(format!("{} couldn't be opened. Save it instead.", file.name)),
                };
                this.file_done(&place, &file.artifact_id, problem);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn save_copy(
        &mut self,
        place: Place,
        file: FileRef,
        stored_name: String,
        bytes: Vec<u8>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = files::safe_name(&stored_name);
        let chosen = cx.prompt_for_new_path(&files::downloads_dir(), Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            let saved = match chosen.await {
                Ok(Ok(Some(path))) => {
                    Some(cx.background_executor().spawn(async move { std::fs::write(&path, bytes) }).await)
                }
                _ => None,
            };
            this.update(cx, |this, cx| {
                let problem = match saved {
                    Some(Err(_)) => Some(format!("{name} couldn't be saved there. Choose another place.")),
                    Some(Ok(())) => {
                        this.notify(format!("Saved {name}"), false, None, cx);
                        None
                    }
                    None => None,
                };
                this.file_done(&place, &file.artifact_id, problem);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

fn full_message(most: usize) -> String {
    match most {
        1 => "A message carries one file.".into(),
        most => format!("A message carries up to {most} files."),
    }
}

/// The transcript's list: it starts at the latest message and stays there as replies arrive,
/// until the person scrolls away; scrolling back to the end picks the latest up again.
fn transcript_list() -> ListState {
    let list = ListState::new(2, ListAlignment::Bottom, px(600.));
    list.set_follow_mode(FollowMode::Tail);
    list
}
