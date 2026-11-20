use super::session::{append, Catalog};
use super::wire::{REQUEST_TIMEOUT, TURN_TIMEOUT};
use super::{field, values, Error, Model, Reply, Wire};
use serde_json::{json, Value};
use tokio::time::timeout;

async fn response(wire: &mut Wire, command: &str) -> Result<Value, Error> {
    loop {
        let frame = wire.read().await?;
        if frame["type"] == "response" {
            if frame["id"] != command || frame["command"] != command {
                return Err(Error::Protocol);
            }
            return if frame["success"] == true {
                Ok(frame)
            } else {
                Err(Error::Remote(0))
            };
        }
        reject_tool_event(&frame)?;
    }
}

fn reject_tool_event(frame: &Value) -> Result<(), Error> {
    match frame["type"].as_str() {
        Some(
            "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end"
            | "extension_ui_request",
        ) => Err(Error::Unsafe),
        _ => Ok(()),
    }
}

pub(super) async fn catalog(wire: &mut Wire) -> Result<Catalog, Error> {
    timeout(REQUEST_TIMEOUT, async {
        wire.write(json!({"id":"get_available_models","type":"get_available_models"}))
            .await?;
        let answer = response(wire, "get_available_models").await?;
        let mut catalog = Catalog {
            current: None,
            models: values(&answer["data"]["models"])
                .filter_map(|entry| {
                    let provider = field(&entry["provider"])?;
                    let model = field(&entry["id"])?;
                    Some(Model {
                        id: format!("{provider}/{model}"),
                        label: field(&entry["name"]).unwrap_or(model).to_owned(),
                        provider: Some(provider.to_owned()),
                    })
                })
                .collect(),
        };
        catalog.dedup();
        wire.write(json!({"id":"get_state","type":"get_state"}))
            .await?;
        let state = response(wire, "get_state").await?;
        let model = &state["data"]["model"];
        catalog.current = field(&model["provider"])
            .zip(field(&model["id"]))
            .map(|(provider, id)| format!("{provider}/{id}"));
        Ok(catalog)
    })
    .await
    .unwrap_or(Err(Error::Timeout))
}

pub(super) async fn select(wire: &mut Wire, model: &str) -> Result<(), Error> {
    let (provider, model_id) = model.split_once('/').ok_or(Error::UnknownModel)?;
    timeout(REQUEST_TIMEOUT, async {
        wire.write(json!({
            "id":"set_model", "type":"set_model", "provider":provider, "modelId":model_id
        }))
        .await?;
        response(wire, "set_model").await?;
        Ok(())
    })
    .await
    .unwrap_or(Err(Error::Timeout))
}

pub(super) async fn prompt(
    wire: &mut Wire,
    text: &str,
    on_text: &mut impl FnMut(&str),
) -> Result<Reply, Error> {
    timeout(TURN_TIMEOUT, async {
        wire.write(json!({"id":"prompt","type":"prompt","message":text}))
            .await?;
        let mut acknowledged = false;
        let mut reply = String::new();
        loop {
            let frame = wire.read().await?;
            reject_tool_event(&frame)?;
            match frame["type"].as_str() {
                Some("response") => {
                    if frame["id"] != "prompt" || frame["command"] != "prompt" {
                        return Err(Error::Protocol);
                    }
                    if frame["success"] != true {
                        return Err(Error::Remote(0));
                    }
                    acknowledged = true;
                }
                Some("message_update")
                    if frame["assistantMessageEvent"]["type"] == "text_delta" =>
                {
                    if let Some(chunk) = frame["assistantMessageEvent"]["delta"].as_str() {
                        append(&mut reply, chunk, on_text)?;
                    }
                }
                Some("agent_end") if acknowledged && frame["willRetry"] != true => {
                    let message = values(&frame["messages"])
                        .filter(|entry| entry["role"] == "assistant")
                        .last();
                    let reason = message
                        .and_then(|entry| field(&entry["stopReason"]))
                        .ok_or(Error::Protocol)?;
                    if reason == "error" {
                        return Err(Error::Remote(0));
                    }
                    if reason == "toolUse" {
                        return Err(Error::Unsafe);
                    }
                    if reply.is_empty() {
                        for part in values(&message.ok_or(Error::Protocol)?["content"]) {
                            if part["type"] == "text" {
                                if let Some(text) = part["text"].as_str() {
                                    append(&mut reply, text, on_text)?;
                                }
                            }
                        }
                    }
                    return Ok(Reply {
                        text: reply,
                        stop_reason: reason.to_owned(),
                    });
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap_or(Err(Error::Timeout))
}
