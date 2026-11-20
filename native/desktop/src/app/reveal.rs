//! Showing one message an Inbox line points at, in the conversation it belongs to.

use std::time::Duration;

use gpui_kit::*;

use crate::api::Target;
use crate::app::Desktop;

/// How long a revealed message stays marked once it is on screen.
const MARKED: Duration = Duration::from_millis(2400);

/// A message being looked for, or just found, in the open conversation. It belongs to the chat
/// on screen, so opening another conversation drops it and with it the search.
#[derive(Default)]
pub struct Reveal {
    /// Still being looked for: in what is loaded, then in older pages.
    pub seeking: Option<String>,
    /// Found and briefly marked.
    pub marked: Option<String>,
    shown: u64,
}

/// What became of a search, when the message could not be shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Missing {
    /// The whole history was read and the message is not in it, or it is one the transcript leaves out.
    NotHere,
    /// The transcript holds as much as it keeps in memory before reaching it.
    BeyondKept,
    /// Older history could not be read.
    Unreadable,
}

impl Missing {
    fn sentence(self) -> &'static str {
        match self {
            Self::NotHere => "That message isn't in this conversation any more.",
            Self::BeyondKept => {
                "That message is older than the app keeps open. The conversation is open at its latest messages."
            }
            Self::Unreadable => "Couldn't read older messages to find that one. Try again.",
        }
    }
}

impl Desktop {
    /// Opens `target`, an agent's first conversation through the conversation list, and shows
    /// `message` in it when one is named. Without one, or once it cannot be found, the
    /// conversation stays open where it starts.
    pub fn open_at(&mut self, target: Target, message: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let opened = target.clone();
        match &target {
            Target::Agent(agent) => {
                let agent = agent.clone();
                self.open_conversation(&agent, None, window, cx);
            }
            _ => self.open(target, window, cx),
        }
        let Some(message) = message else { return };
        let Some(chat) = self.chat.as_mut().filter(|chat| chat.target == opened) else { return };
        chat.reveal.seeking = Some(message);
        chat.reveal.marked = None;
        self.seek_reveal(window, cx);
    }

    /// Looks for the message being revealed in what is loaded and, until it turns up, reads the
    /// page before. Called when the conversation's first read and each older page arrive.
    pub(crate) fn seek_reveal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.chat.as_mut() else { return };
        let Some(wanted) = chat.reveal.seeking.clone() else { return };
        if chat.loading || chat.conversation.loading_older {
            return;
        }
        if let Some(index) = chat.entries.iter().position(|entry| entry.id == wanted) {
            chat.reveal.seeking = None;
            chat.reveal.marked = Some(wanted.clone());
            chat.reveal.shown += 1;
            // The transcript follows its newest message; it resumes once the person scrolls back down.
            chat.list.pause_following_tail();
            chat.list.scroll_to_reveal_item(super::conversation::Chat::row_of(index));
            let (shown, target) = (chat.reveal.shown, chat.target.clone());
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(MARKED).await;
                this.update(cx, |this, cx| {
                    if let Some(chat) = this.chat.as_mut().filter(|chat| chat.target == target) {
                        if chat.reveal.shown == shown {
                            chat.reveal.marked = None;
                            cx.notify();
                        }
                    }
                })
                .ok();
            })
            .detach();
            cx.notify();
            return;
        }
        let state = &chat.conversation;
        let (unread, problem, more, capped) =
            (chat.unread, state.older_problem.is_some(), state.older.is_some(), state.capped);
        let missing = if unread {
            None
        } else if problem {
            Some(Missing::Unreadable)
        } else if more {
            self.load_older(window, cx);
            return;
        } else if capped {
            Some(Missing::BeyondKept)
        } else {
            Some(Missing::NotHere)
        };
        if let Some(chat) = self.chat.as_mut() {
            chat.reveal.seeking = None;
        }
        if let Some(missing) = missing {
            self.notify(missing.sentence(), missing == Missing::Unreadable, None, cx);
        }
    }
}
