use std::time::Duration;

use serde_json::json;

use super::*;
use crate::test_fixture::{card, discovery, event, loopback, snapshot, Exchange};

fn me() -> Exchange {
    Exchange::json(
        "me",
        json!({}),
        "200 OK",
        json!({ "userId": "user-1", "email": "fixture@example.test", "name": "Fixture" }),
    )
    .unscoped()
}

fn opened() -> Exchange {
    let mut empty = snapshot(card());
    empty["messages"] = json!([]);
    empty["activeRuns"] = json!([]);
    Exchange::json("threads/get", json!({ "botId": "bot-1" }), "200 OK", empty)
}

fn sent() -> Exchange {
    Exchange::json(
        "threads/send",
        json!({ "botId": "bot-1", "text": "What colour?" }),
        "200 OK",
        json!({ "taskId": "task-1", "runId": "run-1", "seq": 6 }),
    )
    .fresh(&["clientNonce"])
}

fn send_args() -> send::SendArgs {
    send::SendArgs {
        agent: "tools".into(),
        message: vec!["What".into(), "colour?".into()],
        new_conversation: false,
        conversation: None,
    }
}

async fn send_with(events: &[serde_json::Value], after: Vec<Exchange>, json: bool) -> Result<()> {
    let mut exchanges = discovery();
    exchanges.extend([me(), opened(), sent(), Exchange::events(5, events)]);
    exchanges.extend(after);
    let (client, finished) = loopback(exchanges);
    let result = send::run(&client, None, send_args(), json).await;
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
    result
}

fn exit_status(result: Result<()>) -> Option<u8> {
    result.err()?.downcast_ref::<Exit>().map(|exit| exit.0)
}

#[tokio::test]
async fn send_streams_the_reply_and_exits_cleanly() {
    let events = [
        event(
            6,
            "thread.progress",
            json!({ "streaming": true, "delta": "The fixture " }),
        ),
        event(
            7,
            "thread.progress",
            json!({ "streaming": true, "delta": "response" }),
        ),
        event(
            8,
            "thread.message.created",
            json!({ "messageId": "reply-1", "seq": 7, "role": "bot",
                "blocks": [{ "kind": "text", "text": "The fixture response is blue." }] }),
        ),
        event(9, "run.completed", json!({})),
    ];
    send_with(&events, Vec::new(), false).await.unwrap();
    send_with(&events, Vec::new(), true).await.unwrap();
}

#[tokio::test]
async fn send_reports_a_failed_run_with_status_one() {
    let events = [event(
        6,
        "run.failed",
        json!({ "error": "Model unavailable" }),
    )];
    assert_eq!(
        exit_status(send_with(&events, Vec::new(), false).await),
        Some(1)
    );
    assert_eq!(
        exit_status(send_with(&events, Vec::new(), true).await),
        Some(1)
    );
}

#[tokio::test]
async fn send_stops_on_an_approval_with_its_own_status() {
    let events = [
        event(
            6,
            "thread.message.created",
            json!({ "messageId": "message-1", "role": "bot", "blocks": [card()] }),
        ),
        event(7, "run.waiting_input", json!({})),
    ];
    let reread = || {
        vec![Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            snapshot(card()),
        )]
    };
    assert_eq!(
        exit_status(send_with(&events, reread(), false).await),
        Some(send::WAITING_EXIT)
    );
    assert_eq!(
        exit_status(send_with(&events, reread(), true).await),
        Some(send::WAITING_EXIT)
    );
}

#[tokio::test]
async fn threads_list_the_first_conversation_and_added_ones() {
    let (client, finished) = loopback(vec![
        Exchange::json(
            "threads/head",
            json!({ "botId": "bot-1" }),
            "200 OK",
            json!({ "threadId": "thread-1", "cursor": 5 }),
        ),
        Exchange::json(
            "threads/listBotConversations",
            json!({ "botId": "bot-1" }),
            "200 OK",
            json!([{ "threadId": "thread-2", "botId": "bot-1", "createdAt": "2026-11-20T00:00:00Z",
                "title": "Launch plan", "pinnedAt": null, "archivedAt": null, "preview": null }]),
        ),
    ]);
    let features = Features::new(client);
    let rows = threads::conversations(&features.space("space-1"), &test_fixture::agent())
        .await
        .unwrap();
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| (row.thread_id.as_str(), row.label()))
            .collect::<Vec<_>>(),
        [
            ("thread-1", "First conversation"),
            ("thread-2", "Launch plan")
        ]
    );
}

fn approval_scan(conversations: serde_json::Value) -> Vec<Exchange> {
    vec![
        Exchange::json(
            "threads/get",
            json!({ "botId": "bot-1" }),
            "200 OK",
            snapshot(card()),
        ),
        Exchange::json(
            "threads/listBotConversations",
            json!({ "botId": "bot-1" }),
            "200 OK",
            conversations,
        ),
    ]
}

fn catalog() -> Vec<(Space, Vec<Agent>)> {
    vec![(
        Space {
            id: "space-1".into(),
            name: "Personal".into(),
            shared: false,
        },
        vec![test_fixture::agent()],
    )]
}

#[tokio::test]
async fn approvals_are_found_in_every_open_conversation() {
    let mut exchanges = approval_scan(json!([
        { "threadId": "thread-2", "botId": "bot-1", "createdAt": "2026-11-20T00:00:00Z",
          "title": null, "pinnedAt": null, "archivedAt": null, "preview": null },
        { "threadId": "thread-3", "botId": "bot-1", "createdAt": "2026-11-20T00:00:00Z",
          "title": null, "pinnedAt": null, "archivedAt": "2026-11-21T00:00:00Z", "preview": null },
    ]));
    let mut other = snapshot(card());
    other["threadId"] = json!("thread-2");
    other["messages"][0]["id"] = json!("message-2");
    exchanges.push(Exchange::json(
        "threads/get",
        json!({ "botId": "bot-1", "threadId": "thread-2" }),
        "200 OK",
        other,
    ));
    let (client, finished) = loopback(exchanges);
    let found = approvals::pending(&Features::new(client), &catalog())
        .await
        .unwrap();
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        found
            .iter()
            .map(|approval| (approval.id.as_str(), approval.conversation.as_deref()))
            .collect::<Vec<_>>(),
        [("message-1", None), ("message-2", Some("thread-2"))]
    );
    assert_eq!(
        found[0].lines(),
        "message-1  Personal / Tools\n  Allow convert_temperature?\n  Site: units.example.test\n"
    );
    let listed = serde_json::to_value(&found[1]).unwrap();
    assert_eq!(listed["threadId"], "thread-2");
    assert_eq!(listed["runId"], "run-1");
}

#[tokio::test]
async fn approvals_allow_and_deny_answer_the_listed_card() {
    for (command, answer) in [
        (
            approvals::ApprovalCommand::Allow {
                id: "message-1".into(),
            },
            "allow",
        ),
        (
            approvals::ApprovalCommand::Deny {
                id: "message-1".into(),
            },
            "deny",
        ),
    ] {
        let mut exchanges = approval_scan(json!([]));
        exchanges.push(Exchange::json(
            "threads/answer",
            json!({ "botId": "bot-1", "runId": "run-1", "messageId": "message-1", "answer": answer }),
            "200 OK",
            json!({ "ok": true }),
        ));
        let (client, finished) = loopback(exchanges);
        approvals::run(&Features::new(client), &catalog(), Some(command), false)
            .await
            .unwrap();
        finished.recv_timeout(Duration::from_secs(3)).unwrap();
    }
}

#[tokio::test]
async fn an_unknown_or_stale_approval_is_an_error() {
    let (client, finished) = loopback(approval_scan(json!([])));
    let unknown = approvals::ApprovalCommand::Allow {
        id: "message-9".into(),
    };
    assert!(
        approvals::run(&Features::new(client), &catalog(), Some(unknown), false)
            .await
            .is_err()
    );
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut exchanges = approval_scan(json!([]));
    exchanges.push(Exchange::json(
        "threads/answer",
        json!({ "botId": "bot-1", "runId": "run-1", "messageId": "message-1", "answer": "deny" }),
        "409 Conflict",
        json!({ "code": "CONFLICT", "message": "This prompt is no longer awaiting an answer" }),
    ));
    let (client, finished) = loopback(exchanges);
    let stale = approvals::ApprovalCommand::Deny {
        id: "message-1".into(),
    };
    assert!(
        approvals::run(&Features::new(client), &catalog(), Some(stale), false)
            .await
            .is_err()
    );
    finished.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[test]
fn new_commands_parse_with_json_and_space_options() {
    let args = Args::try_parse_from([
        "superbot", "--json", "--space", "Team", "send", "Tools", "What", "colour?",
    ])
    .unwrap();
    assert!(args.json);
    assert_eq!(args.space.as_deref(), Some("Team"));
    assert!(
        matches!(args.command, Some(Command::Send { agent, message, .. }) if agent == "Tools" && message == ["What", "colour?"])
    );
    assert!(matches!(
        Args::try_parse_from(["superbot", "approvals", "deny", "message-1"])
            .unwrap()
            .command,
        Some(Command::Approvals {
            command: Some(approvals::ApprovalCommand::Deny { .. })
        })
    ));
    assert!(matches!(
        Args::try_parse_from(["superbot", "threads", "show", "Tools", "thread-2"])
            .unwrap()
            .command,
        Some(Command::Threads(threads::ThreadsCommand::Show {
            thread_id: Some(_),
            ..
        }))
    ));
    assert!(Args::try_parse_from(["superbot", "login", "--password-stdin"]).is_err());
    assert!(Args::try_parse_from([
        "superbot",
        "login",
        "--email",
        "a@example.test",
        "--code",
        "--password-stdin"
    ])
    .is_err());
}
