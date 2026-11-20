//! Messages the sidebar search finds in the Space, listed below the agents whose names match.

use std::ops::Range;
use std::time::Duration;

use gpui_kit::*;
use superbot_features::{Features, SearchHit, SearchHitKind};

use crate::api::Target;
use crate::app::Desktop;
use crate::theme::{radius, Theme};
use crate::ui::inbox::conversation;
use crate::ui::{empty_line, Type};

/// Fewer characters than this filter the agents only.
const SHORTEST: usize = 2;
/// The server takes queries up to this many characters.
const LONGEST: usize = 200;
const TYPING_PAUSE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct MessageSearch {
    asked: u64,
    answer: Option<Answer>,
}

struct Answer {
    space: String,
    query: String,
    found: Result<Vec<Found>, ()>,
}

/// One message a search found, and the conversation it opens.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub target: Target,
    pub message: String,
    pub chat: String,
    pub snippet: String,
}

/// What the server is asked for what is typed, when it is long enough to ask.
fn searchable(typed: &str) -> Option<String> {
    let typed = typed.trim();
    (typed.chars().count() >= SHORTEST).then(|| typed.chars().take(LONGEST).collect())
}

/// The hits that point at a message, one row per message, in the server's order.
fn messages(hits: Vec<SearchHit>) -> Vec<Found> {
    let mut found: Vec<Found> = Vec::new();
    for hit in hits {
        if !matches!(hit.kind, SearchHitKind::Message | SearchHitKind::Link) {
            continue;
        }
        let (Some(target), Some(message)) = (hit.target(), hit.message_id) else { continue };
        if found.iter().any(|known| known.message == message) {
            continue;
        }
        let chat = hit.group_name.or(hit.bot_name).unwrap_or(hit.title);
        let snippet = hit.snippet.split_whitespace().collect::<Vec<_>>().join(" ");
        found.push(Found { target: conversation(&target), message, chat, snippet });
    }
    found
}

/// Where `query` first appears in `text`, ignoring case.
fn matched(text: &str, query: &str) -> Option<Range<usize>> {
    let query = query.to_lowercase();
    let ends = || text.char_indices().map(|(at, _)| at).skip(1).chain([text.len()]);
    text.char_indices().map(|(at, _)| at).find_map(|start| {
        ends()
            .filter(|end| *end > start)
            .map(|end| (end, text[start..end].to_lowercase()))
            .take_while(|(_, piece)| piece.len() <= query.len())
            .find(|(_, piece)| *piece == query)
            .map(|(end, _)| start..end)
    })
}

impl Desktop {
    /// Asks the server once typing pauses. An answer for older words, or for a Space or account
    /// left since, is dropped.
    pub fn search_messages(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.message_search.asked += 1;
        let asked = self.message_search.asked;
        let Some(query) = searchable(&self.search.read(cx).value()) else { return };
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(TYPING_PAUSE).await;
            this.update_in(cx, |this, window, cx| {
                let (Some(api), Some(space)) = (this.api.clone(), this.space_id()) else { return };
                if this.message_search.asked != asked {
                    return;
                }
                let features = Features::new(api.client.clone());
                let (words, scope) = (query.clone(), space.clone());
                let work = async move { features.space(scope).search(&words).await };
                this.call(window, cx, work, move |this, result, _, _| {
                    if this.message_search.asked == asked {
                        let found = result.map(messages).map_err(|_| ());
                        this.message_search.answer = Some(Answer { space, query, found });
                    }
                });
            })
            .ok();
        })
        .detach();
    }

    pub fn forget_message_search(&mut self) {
        self.message_search = MessageSearch::default();
    }

    fn open_found(&mut self, found: Found, window: &mut Window, cx: &mut Context<Self>) {
        self.search_open = false;
        self.search.update(cx, |search, cx| search.set_value("", window, cx));
        self.open_at(found.target, Some(found.message), window, cx);
    }

    /// The Messages section for what is typed, when it is long enough to search.
    pub fn render_message_search(&mut self, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        let query = searchable(&self.search.read(cx).value())?;
        let space = self.space_id();
        let answer = self
            .message_search
            .answer
            .as_ref()
            .filter(|answer| answer.query == query && Some(&answer.space) == space.as_ref());
        let heading = match answer.map(|answer| &answer.found) {
            Some(Ok(found)) if !found.is_empty() => format!("Messages · {}", found.len()),
            _ => "Messages".to_owned(),
        };
        let section = div().flex().flex_col().gap_0p5().pt_2().pb_2().border_t_1().border_color(theme.hairline).child(
            div()
                .px_2()
                .pt_1()
                .pb_1()
                .meta()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink_secondary)
                .child(heading),
        );
        Some(match answer.map(|answer| answer.found.clone()) {
            None => section,
            Some(Err(())) => section.child(
                div()
                    .id("message-search-retry")
                    .px_2()
                    .py_1()
                    .flex()
                    .gap_1()
                    .cursor_pointer()
                    .child(empty_line("Couldn't search messages.", theme))
                    .child(div().body().text_color(theme.ink).child("Try again"))
                    .on_click(cx.listener(|this, _, window, cx| this.search_messages(window, cx))),
            ),
            Some(Ok(found)) if found.is_empty() => {
                section.child(div().px_2().py_1().child(empty_line(format!("No messages match “{query}”"), theme)))
            }
            Some(Ok(found)) => section.children(
                found.into_iter().enumerate().map(|(index, found)| self.render_found(index, found, &query, theme, cx)),
            ),
        })
    }

    fn render_found(
        &self,
        index: usize,
        found: Found,
        query: &str,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover = theme.raised.opacity(0.5);
        let mark = HighlightStyle {
            color: Some(theme.ink),
            background_color: Some(theme.accent.opacity(0.25)),
            ..Default::default()
        };
        let snippet = match matched(&found.snippet, query) {
            Some(range) => StyledText::new(found.snippet.clone()).with_highlights([(range, mark)]),
            None => StyledText::new(found.snippet.clone()),
        };
        let face = self.target_face(&found.target, px(26.), None, theme, cx);
        let chat = found.chat.clone();
        div()
            .id(("found", index))
            .w_full()
            .flex()
            .items_start()
            .gap_2p5()
            .px_2()
            .py_2()
            .rounded(radius::FIELD)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| this.open_found(found.clone(), window, cx)))
            .child(face.mt(px(1.)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink).truncate().child(chat))
                    .child(div().mt(px(2.)).body().text_color(theme.ink_secondary).line_clamp(2).child(snippet)),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use superbot_features::{SearchHit, SearchHitKind};

    use super::{matched, messages, searchable, Found};
    use crate::api::Target;

    fn hit(kind: SearchHitKind, message: Option<&str>) -> SearchHit {
        SearchHit {
            kind,
            bot_id: Some("bot".into()),
            bot_name: Some("Ada".into()),
            thread_id: None,
            group_id: None,
            group_name: None,
            title: "Ada".into(),
            snippet: "the  okapi\nplan".into(),
            message_id: message.map(Into::into),
        }
    }

    #[test]
    fn short_words_filter_the_roster_only_and_long_ones_are_cut_to_what_the_server_takes() {
        assert_eq!(searchable(" a "), None);
        assert_eq!(searchable(" ok ").as_deref(), Some("ok"));
        assert_eq!(searchable(&"é".repeat(300)).map(|query| query.chars().count()), Some(200));
    }

    #[test]
    fn each_message_is_listed_once_in_the_conversation_it_belongs_to() {
        let other = SearchHit { thread_id: Some("thread".into()), ..hit(SearchHitKind::Message, Some("m2")) };
        let group = SearchHit {
            bot_id: None,
            bot_name: None,
            group_id: Some("group".into()),
            group_name: Some("Team".into()),
            ..hit(SearchHitKind::Link, Some("m3"))
        };
        let found = messages(vec![
            hit(SearchHitKind::Conversation, None),
            hit(SearchHitKind::Message, Some("m1")),
            hit(SearchHitKind::Link, Some("m1")),
            hit(SearchHitKind::File, Some("m4")),
            hit(SearchHitKind::Routine, None),
            other,
            group,
        ]);
        let first = Found {
            target: Target::Agent("bot".into()),
            message: "m1".into(),
            chat: "Ada".into(),
            snippet: "the okapi plan".into(),
        };
        assert_eq!(found[0], first);
        assert_eq!(
            found.iter().map(|found| (&found.target, found.message.as_str())).collect::<Vec<_>>(),
            [
                (&Target::Agent("bot".into()), "m1"),
                (&Target::Conversation { agent: "bot".into(), thread: "thread".into() }, "m2"),
                (&Target::Group("group".into()), "m3"),
            ]
        );
        assert_eq!(found[2].chat, "Team");
    }

    #[test]
    fn the_typed_words_are_marked_in_the_snippet_whatever_their_case() {
        assert_eq!(matched("…the Okapi plan", "okapi"), Some(7..12));
        assert_eq!(matched("Straße und mehr", "STRASSE"), None);
        assert_eq!(matched("Café latte", "café"), Some(0..5));
        assert_eq!(matched("plan", "okapi"), None);
    }
}
