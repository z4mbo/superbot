//! Drives the desktop's T3 Code inbox steps against a fixture T3 endpoint. Reads one JSON
//! command per line on stdin and answers one JSON line on stdout. Tokens never reach stdout.

use std::io::{BufRead, Write};

use serde_json::{json, Value};
use superbot_t3_inbox::{begin_sign_in, projects, start, Grant, Ledger, Start, T3Error};

fn failure(error: &T3Error) -> Value {
    let debug = format!("{error:?}");
    let kind: String = debug.chars().take_while(|letter| letter.is_alphanumeric()).collect();
    json!({ "ok": false, "kind": kind, "message": error.to_string() })
}

async fn sign_in(url: &str) -> Result<Grant, T3Error> {
    let pending = begin_sign_in(url).await?;
    let authorize = pending.authorization_url.clone();
    let finish = tokio::spawn(pending.finish());
    let browser = reqwest::Client::builder().no_proxy().build().expect("an HTTP client");
    browser.get(authorize).send().await.map_err(|_| T3Error::SignInDenied)?;
    finish.await.map_err(|_| T3Error::SignInDenied)?
}

async fn run_start(grant: &Grant, command: &Value) -> Value {
    let text = |key: &str| command[key].as_str().unwrap_or_default().to_owned();
    let ledger = Ledger::new(text("dir"));
    let (server, space, installation, record, project, title, brief) = (
        text("server"),
        text("space"),
        text("installation"),
        text("record"),
        text("project"),
        text("title"),
        text("brief"),
    );
    let request = Start {
        server: &server,
        space: &space,
        installation: &installation,
        record_id: &record,
        project_id: &project,
        title: &title,
        brief: &brief,
    };
    match start(&ledger, grant, &request).await {
        Ok(started) => {
            json!({ "ok": true, "operationId": started.plan.operation_id, "receipt": started.receipt.values() })
        }
        Err(error) => failure(&error),
    }
}

#[tokio::main]
async fn main() {
    let mut grant: Option<Grant> = None;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let command: Value = serde_json::from_str(&line).expect("a JSON command");
        let answer = match (command["cmd"].as_str().unwrap_or_default(), &grant) {
            ("sign_in", _) => match sign_in(command["url"].as_str().unwrap_or_default()).await {
                Ok(signed) => {
                    let answer = json!({ "ok": true, "place": signed.place(), "debug": format!("{signed:?}") });
                    grant = Some(signed);
                    answer
                }
                Err(error) => failure(&error),
            },
            ("use_token", Some(current)) => {
                grant = Some(Grant {
                    url: current.url.clone(),
                    token: command["token"].as_str().unwrap_or_default().to_owned(),
                });
                json!({ "ok": true })
            }
            ("projects", Some(current)) => match projects(current).await {
                Ok(found) => {
                    json!({ "ok": true, "projects": found.iter().map(|project| json!({ "id": project.id, "title": project.title })).collect::<Vec<_>>() })
                }
                Err(error) => failure(&error),
            },
            ("start", Some(current)) => run_start(current, &command).await,
            ("start_twice", Some(current)) => {
                let (first, second) = tokio::join!(run_start(current, &command), run_start(current, &command));
                json!({ "ok": true, "results": [first, second] })
            }
            _ => json!({ "ok": false, "kind": "Usage" }),
        };
        let mut out = std::io::stdout().lock();
        writeln!(out, "{answer}").expect("stdout");
        out.flush().expect("stdout");
    }
}
