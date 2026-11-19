use std::{
    io::{BufRead, BufReader, Read},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};

use serde_json::{json, Value};

use super::*;

fn card() -> Value {
    json!({
        "kind": "ask",
        "status": "pending",
        "approvalEffectId": "effect-1",
        "text": "Allow convert_temperature?",
        "site": "units.example.test",
        "detail": "Endpoint: https://units.example.test/mcp\nArguments: {\"value\":100}",
        "actions": [
            { "id": "allow", "label": "Allow once" },
            { "id": "always", "label": "Always allow this tool" },
            { "id": "deny", "label": "Deny" }
        ]
    })
}

fn snapshot(block: Value) -> Value {
    json!({
        "threadId": "thread-1",
        "cursor": 5,
        "activeRuns": [{ "id": "run-1", "status": "waiting_input" }],
        "messages": [{
            "id": "message-1",
            "role": "bot",
            "seq": 1,
            "threadId": "thread-1",
            "runId": "run-1",
            "createdAt": "2026-11-19T00:00:00Z",
            "blocks": [block],
        }],
    })
}

struct Exchange {
    procedure: &'static str,
    input: Value,
    status: &'static str,
    content_type: &'static str,
    body: String,
}

impl Exchange {
    fn json(procedure: &'static str, input: Value, status: &'static str, response: Value) -> Self {
        Self {
            procedure,
            input,
            status,
            content_type: "application/json",
            body: json!({ "json": response }).to_string(),
        }
    }

    fn events(cursor: i64, events: &[Value]) -> Self {
        Self {
            procedure: "threads/subscribe",
            input: json!({ "botId": "bot-1", "cursor": cursor }),
            status: "200 OK",
            content_type: "text/event-stream",
            body: events
                .iter()
                .map(|event| format!("event: message\ndata: {}\n\n", json!({ "json": event })))
                .collect(),
        }
    }
}

fn event(seq: i64, kind: &str, payload: Value) -> Value {
    json!({ "id": format!("event-{seq}"), "seq": seq, "runId": "run-1",
        "botId": "bot-1", "type": kind, "payload": payload })
}

fn loopback(exchanges: Vec<Exchange>) -> (Client, mpsc::Receiver<()>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = Client::new(&format!("http://{}", server.local_addr().unwrap()))
        .unwrap()
        .with_token("fixture.signed")
        .unwrap();
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        for exchange in exchanges {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim(),
                format!("POST /rpc/{} HTTP/1.1", exchange.procedure)
            );
            let mut headers = std::collections::HashMap::new();
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap();
                headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
            }
            assert_eq!(headers["authorization"], "Bearer fixture.signed");
            assert_eq!(headers["x-rakazo-space-id"], "space-1");
            let mut request = vec![0; headers["content-length"].parse().unwrap()];
            reader.read_exact(&mut request).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&request).unwrap(),
                json!({ "json": exchange.input }),
            );
            write!(socket, "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                exchange.status, exchange.content_type, exchange.body.len(), exchange.body).unwrap();
        }
        let _ = done.send(());
    });
    (client, finished)
}

fn agent() -> Agent {
    Agent {
        id: "bot-1".into(),
        name: "Tools".into(),
    }
}

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
