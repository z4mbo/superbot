//! A loopback Superbot server for command tests: each exchange answers one request in order
//! and checks what the client sent.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};

use serde_json::{json, Value};
use superbot_client::{Agent, Client};

pub(crate) fn card() -> Value {
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

pub(crate) fn snapshot(block: Value) -> Value {
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

pub(crate) struct Exchange {
    procedure: &'static str,
    /// The Space header the request must carry; `None` for account-wide requests.
    space: Option<&'static str>,
    input: Value,
    /// Input fields the client fills with fresh values, checked only for presence.
    fresh: &'static [&'static str],
    status: &'static str,
    content_type: &'static str,
    body: String,
}

impl Exchange {
    pub(crate) fn json(
        procedure: &'static str,
        input: Value,
        status: &'static str,
        response: Value,
    ) -> Self {
        Self {
            procedure,
            space: Some("space-1"),
            input,
            fresh: &[],
            status,
            content_type: "application/json",
            body: json!({ "json": response }).to_string(),
        }
    }

    /// Accepts any value for these input fields, such as a nonce.
    pub(crate) fn fresh(mut self, fields: &'static [&'static str]) -> Self {
        self.fresh = fields;
        self
    }

    /// A request that names no Space, such as `me` or `spaces/list`.
    pub(crate) fn unscoped(mut self) -> Self {
        self.space = None;
        self
    }

    pub(crate) fn events(cursor: i64, events: &[Value]) -> Self {
        Self {
            procedure: "threads/subscribe",
            space: Some("space-1"),
            input: json!({ "botId": "bot-1", "cursor": cursor }),
            fresh: &[],
            status: "200 OK",
            content_type: "text/event-stream",
            body: events
                .iter()
                .map(|event| format!("event: message\ndata: {}\n\n", json!({ "json": event })))
                .collect(),
        }
    }
}

pub(crate) fn event(seq: i64, kind: &str, payload: Value) -> Value {
    json!({ "id": format!("event-{seq}"), "seq": seq, "runId": "run-1",
        "botId": "bot-1", "type": kind, "payload": payload })
}

pub(crate) fn loopback(exchanges: Vec<Exchange>) -> (Client, mpsc::Receiver<()>) {
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
            let mut headers = HashMap::new();
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
            assert_eq!(
                headers.get("x-rakazo-space-id").map(String::as_str),
                exchange.space,
                "{}",
                exchange.procedure
            );
            let mut request = vec![0; headers["content-length"].parse().unwrap()];
            reader.read_exact(&mut request).unwrap();
            let mut request: Value = serde_json::from_slice(&request).unwrap();
            for field in exchange.fresh {
                assert!(
                    request["json"]
                        .as_object_mut()
                        .and_then(|input| input.remove(*field))
                        .is_some(),
                    "{} sends {field}",
                    exchange.procedure
                );
            }
            assert_eq!(request, json!({ "json": exchange.input }));
            write!(socket, "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                exchange.status, exchange.content_type, exchange.body.len(), exchange.body).unwrap();
        }
        let _ = done.send(());
    });
    (client, finished)
}

pub(crate) fn agent() -> Agent {
    Agent {
        id: "bot-1".into(),
        name: "Tools".into(),
    }
}

/// The requests that discover one Space with one agent, as `discover` makes them.
pub(crate) fn discovery() -> Vec<Exchange> {
    vec![
        Exchange::json(
            "spaces/list",
            json!({}),
            "200 OK",
            json!({ "current": { "id": "space-1" }, "spaces": [{ "id": "space-1", "name": "Personal" }] }),
        )
        .unscoped(),
        Exchange::json(
            "organizations/list",
            json!({}),
            "404 Not Found",
            json!({ "code": "NOT_FOUND", "message": "Not found" }),
        )
        .unscoped(),
        Exchange::json(
            "bots/list",
            json!({}),
            "200 OK",
            json!([{ "id": "bot-1", "name": "Tools" }]),
        ),
    ]
}
