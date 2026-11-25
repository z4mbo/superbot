use std::time::Duration;

use serde_json::json;

use super::*;
use crate::test_fixture::{agent, card, event, loopback, snapshot, Exchange};

async fn answer_through_stream(input: &'static str, action: &'static str, stale: bool) {
    let requested = [
        event(
            4,
            "thread.message.created",
            json!({ "messageId": "message-1", "role": "bot", "blocks": [card()] }),
        ),
        event(5, "run.waiting_input", json!({})),
    ];
    let mut exchanges = vec![
        Exchange::events(3, &requested),
        Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            snapshot(card()),
        ),
        if stale {
            Exchange::json(
                "threads/answer",
                json!({ "botId": "bot-1", "runId": "run-1", "messageId": "message-1", "answer": action }),
                "409 Conflict",
                json!({ "code": "CONFLICT", "message": "This prompt is no longer awaiting an answer" }),
            )
        } else {
            Exchange::json(
                "threads/answer",
                json!({ "botId": "bot-1", "runId": "run-1", "messageId": "message-1", "answer": action }),
                "200 OK",
                json!({ "ok": true }),
            )
        },
    ];
    if !stale {
        exchanges.push(Exchange::events(
            5,
            &[
                event(
                    6,
                    "thread.message.created",
                    json!({ "role": "bot", "blocks": [{
                "kind": "text", "text": if action == "allow" { "212 Fahrenheit" } else { "Denied." }
            }] }),
                ),
                event(7, "run.completed", json!({})),
            ],
        ));
    }
    let (client, finished) = loopback(exchanges);
    let features = Features::new(client);
    let agent = agent();
    let thread = ChatThread {
        space: features.space("space-1"),
        agent: &agent,
        conversation: None,
        interactive: true,
    };
    let mut reply = Some(input.to_owned());
    let mut cursor = 3;
    follow_reply(
        &thread,
        &mut cursor,
        vec!["run-1".into()],
        None,
        &mut async || Ok(Some(reply.take().expect("exactly one terminal prompt"))),
    )
    .await
    .unwrap();
    assert!(reply.is_none());
    assert_eq!(cursor, if stale { 5 } else { 7 });
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[tokio::test]
async fn approves_once_and_follows_completion() {
    answer_through_stream("1", "allow", false).await;
}

#[tokio::test]
async fn denies_and_follows_completion() {
    answer_through_stream("2", "deny", false).await;
}

#[tokio::test]
async fn stale_answer_is_never_retried() {
    answer_through_stream("1", "allow", true).await;
}

#[tokio::test]
async fn noninteractive_and_empty_input_leave_pending() {
    let (client, finished) = loopback(vec![
        Exchange::events(3, &[event(5, "run.waiting_input", json!({}))]),
        Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            snapshot(card()),
        ),
    ]);
    let features = Features::new(client);
    let agent = agent();
    let mut thread = ChatThread {
        space: features.space("space-1"),
        agent: &agent,
        conversation: None,
        interactive: false,
    };
    let mut cursor = 3;
    follow_reply(
        &thread,
        &mut cursor,
        vec!["run-1".into()],
        None,
        &mut async || {
            panic!("piped input must never be read as an approval");
        },
    )
    .await
    .unwrap();
    assert_eq!(cursor, 5);
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
    thread.interactive = true;
    let snapshot = serde_json::from_value(snapshot(card())).unwrap();
    for input in [None, Some(""), Some("always"), Some("3")] {
        let outcome = thread
            .offer(&snapshot, "run-1", &mut async || {
                Ok(input.map(str::to_owned))
            })
            .await
            .unwrap();
        assert!(matches!(outcome, approvals::Outcome::LeftPending));
    }
}

#[tokio::test]
async fn protects_secret_typed_and_space_permission_cards() {
    let (client, _) = loopback(Vec::new());
    let features = Features::new(client);
    let agent = agent();
    let thread = ChatThread {
        space: features.space("space-1"),
        agent: &agent,
        conversation: None,
        interactive: true,
    };
    let mut secret = card();
    secret["input"] = json!("secret");
    let mut typed = card();
    typed["input"] = json!("text");
    let mut scope = card();
    scope["actions"][0]["label"] = json!("Allow in this space");
    let mut receipt = card();
    receipt["receipt"] = json!({});
    for block in [secret, typed, scope, receipt] {
        let snapshot = serde_json::from_value(snapshot(block)).unwrap();
        let outcome = thread
            .offer(&snapshot, "run-1", &mut async || {
                panic!("use the web for this card");
            })
            .await
            .unwrap();
        assert!(matches!(outcome, approvals::Outcome::LeftPending));
    }
}

#[tokio::test]
async fn resumes_an_outstanding_approval_from_the_initial_snapshot() {
    let (client, finished) = loopback(vec![
        Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            snapshot(card()),
        ),
        Exchange::json(
            "threads/answer",
            json!({ "botId": "bot-1", "runId": "run-1", "messageId": "message-1", "answer": "allow" }),
            "200 OK",
            json!({ "ok": true }),
        ),
        Exchange::events(5, &[event(6, "run.completed", json!({}))]),
    ]);
    let features = Features::new(client);
    let agent = agent();
    let thread = ChatThread {
        space: features.space("space-1"),
        agent: &agent,
        conversation: None,
        interactive: true,
    };
    let snapshot = thread.space.thread(thread.target()).await.unwrap();
    let mut cursor = snapshot.cursor;
    resume_waiting(&thread, &snapshot, &mut cursor, &mut async || {
        Ok(Some("1".into()))
    })
    .await
    .unwrap();
    assert_eq!(cursor, 6);
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[tokio::test]
async fn a_replayed_waiting_event_for_an_answered_card_does_not_prompt() {
    let mut resolved = snapshot(card());
    resolved["activeRuns"][0]["status"] = json!("running");
    let (client, finished) = loopback(vec![
        Exchange::events(3, &[event(5, "run.waiting_input", json!({}))]),
        Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            resolved,
        ),
        Exchange::events(5, &[event(6, "run.completed", json!({}))]),
    ]);
    let features = Features::new(client);
    let agent = agent();
    let thread = ChatThread {
        space: features.space("space-1"),
        agent: &agent,
        conversation: None,
        interactive: true,
    };
    let mut cursor = 3;
    follow_reply(
        &thread,
        &mut cursor,
        vec!["run-1".into()],
        None,
        &mut async || {
            panic!("a replayed event must not reopen an answered approval");
        },
    )
    .await
    .unwrap();
    assert_eq!(cursor, 6);
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
}
