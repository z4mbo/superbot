use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Number};

use crate::local_cli::{
    run_local_prompt, uses_local_cli_driver, InstalledModel, LocalCli, PromptScope,
};
use crate::{local_acp, Error, SpaceFeatures};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPin {
    pub installation_id: String,
    pub part_id: String,
    pub version_id: String,
    pub grant_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedApp {
    pub pin: AppPin,
    pub plugin_name: String,
    pub part: AppPart,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPart {
    pub id: String,
    pub fields: Vec<AppField>,
    pub summary_field: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AppField {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: FieldType,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Number,
    Date,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrantedApps {
    pub items: Vec<GrantedApp>,
    pub next_after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppContext {
    pub app: GrantedApp,
    pub items: Vec<AppRecord>,
    pub total: Option<f64>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRecord {
    pub id: String,
    pub created_at: String,
    pub values: AppValues,
}

pub type AppValues = BTreeMap<String, AppValue>;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AppValue {
    Text(String),
    Number(Number),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppSuggestion {
    pub answer: String,
    pub addition: Option<AppValues>,
}

impl SpaceFeatures<'_> {
    pub async fn local_record_apps(
        &self,
        bot_id: &str,
        after: Option<&str>,
    ) -> Result<GrantedApps, Error> {
        let mut input = json!({ "botId": bot_id });
        if let Some(after) = after {
            input["after"] = json!(after);
        }
        self.call("localAppRecords/list", input).await
    }

    pub async fn local_record_context(
        &self,
        bot_id: &str,
        app: &AppPin,
        date: Option<&str>,
    ) -> Result<AppContext, Error> {
        let mut input = json!({ "botId": bot_id, "app": app });
        if let Some(date) = date {
            input["date"] = json!(date);
        }
        self.call("localAppRecords/context", input).await
    }

    /// Submit from the approval handler, keeping the original pin, UUID and values on retry.
    pub async fn add_local_app_record(
        &self,
        bot_id: &str,
        app: &AppPin,
        operation_id: &str,
        values: &AppValues,
    ) -> Result<AppRecord, Error> {
        self.call(
            "localAppRecords/add",
            json!({ "botId": bot_id, "app": app, "operationId": operation_id, "values": values }),
        )
        .await
    }
}

/// Checks the selection without launching a process. The adapter verifies its scope before use.
pub fn supports_app_assistance(model: &InstalledModel) -> bool {
    uses_local_cli_driver(model) || local_acp::supports_private_prompt(&model.provider)
}

const PROMPT: &str = include_str!("local_app_records.prompt.txt");
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_REPLY_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024;
const MAX_ANSWER_BYTES: usize = 4 * 1024;

/// Runs a prompt-only turn with one app's context. The result is a local draft.
pub async fn suggest_app_record(
    cli: &LocalCli,
    model: &InstalledModel,
    context: &AppContext,
    date: Option<&str>,
    request: &str,
) -> Result<AppSuggestion, String> {
    if request.trim().is_empty() || request.len() > MAX_REQUEST_BYTES {
        return Err("Enter an app request of up to 4 KiB.".into());
    }
    let data = json!({
        "request": request,
        "appName": context.app.plugin_name,
        "fields": context.app.part.fields,
        "dateFilter": date,
        "records": context.items.iter().map(|record| &record.values).collect::<Vec<_>>(),
        "summaryField": context.app.part.summary_field,
        "total": context.total,
        "hasMore": context.has_more,
    });
    let prompt = format!("{PROMPT}\n{data}");
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("The app context is too large for local assistance.".into());
    }
    let reply = run_local_prompt(cli, model, &prompt, PromptScope::AppRecords).await?;
    if reply.len() > MAX_REPLY_BYTES {
        return Err("The local app reply was too large.".into());
    }
    let result: AppSuggestion = serde_json::from_str(&reply)
        .map_err(|_| "The local model didn't return a valid app answer.")?;
    if result.answer.trim().is_empty() || result.answer.len() > MAX_ANSWER_BYTES {
        return Err("The local model didn't return a valid app answer.".into());
    }
    if let Some(values) = &result.addition {
        if !valid_addition(&context.app.part, values) {
            return Err("The suggested addition doesn't match the app fields.".into());
        }
    }
    Ok(result)
}

fn valid_addition(part: &AppPart, values: &AppValues) -> bool {
    if values.is_empty()
        || values
            .keys()
            .any(|id| !part.fields.iter().any(|field| field.id == *id))
    {
        return false;
    }
    part.fields
        .iter()
        .all(|field| match (values.get(&field.id), &field.kind) {
            (None, _) => !field.required,
            (Some(AppValue::Text(text)), FieldType::Text) => {
                text == text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                    && !text.is_empty()
                    && text.encode_utf16().count() <= 2000
                    && !text.contains('\0')
            }
            (Some(AppValue::Number(number)), FieldType::Number) => {
                number.as_f64().is_some_and(|value| value.abs() <= 1e12)
            }
            (Some(AppValue::Text(text)), FieldType::Date) => valid_date(text),
            _ => false,
        })
}

fn valid_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..4]
            .iter()
            .chain(&bytes[5..7])
            .chain(&bytes[8..])
            .all(u8::is_ascii_digit)
    {
        return false;
    }
    let year: u16 = text[..4].parse().unwrap_or_default();
    let month: u8 = text[5..7].parse().unwrap_or_default();
    let day: u8 = text[8..].parse().unwrap_or_default();
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    (1..=days).contains(&day)
}
