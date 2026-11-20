use anyhow::{bail, Context, Result};
use superbot_client::Error;
use superbot_features::local_app_records::{
    suggest_app_record, supports_app_assistance, AppContext, AppPin, AppValue, AppValues,
    GrantedApps,
};
use superbot_features::local_cli::{InstalledModel, LocalCli};
use superbot_features::SpaceFeatures;
use uuid::Uuid;

use crate::{auth_hint, prompt};

#[derive(Default)]
pub(crate) struct LocalAppChat {
    page: Option<GrantedApps>,
    approved: Option<ApprovedAddition>,
}

struct ApprovedAddition {
    pin: AppPin,
    id: Uuid,
    values: AppValues,
}

pub(crate) fn is_command(input: &str) -> bool {
    matches!(input.split_whitespace().next(), Some("/apps" | "/app"))
}

impl LocalAppChat {
    pub(crate) async fn handle(
        &mut self,
        space: &SpaceFeatures<'_>,
        bot_id: &str,
        cli: &LocalCli,
        model: Option<InstalledModel>,
        input: &str,
    ) -> Result<()> {
        if input == "/app retry" {
            return self.save(space, bot_id).await;
        }
        if input == "/app discard" {
            if self.approved.take().is_some() {
                println!("Cleared the pending save from this session.");
            }
            return Ok(());
        }
        let Some(model) = model.filter(supports_app_assistance) else {
            bail!("App assistance requires a selected prompt-only local model.");
        };
        match input {
            "/apps" | "/apps next" => {
                let after = if input == "/apps next" {
                    let Some(after) = self
                        .page
                        .as_ref()
                        .and_then(|page| page.next_after.as_deref())
                    else {
                        println!("No next page. Type /apps to start from the first page.");
                        return Ok(());
                    };
                    Some(after)
                } else {
                    None
                };
                let page = space
                    .local_record_apps(bot_id, after)
                    .await
                    .map_err(|error| {
                        if matches!(error, Error::Server { status: 404, .. }) {
                            anyhow::anyhow!("This server doesn't support local app assistance.")
                        } else {
                            auth_hint(error)
                        }
                    })?;
                for (index, app) in page.items.iter().enumerate() {
                    println!(
                        "{}. {} ({})",
                        index + 1,
                        app.plugin_name.escape_debug(),
                        app.part.id
                    );
                }
                if page.items.is_empty() {
                    println!("No granted record apps on this page.");
                } else {
                    println!(
                        "Use /app NUMBER to view records or /app NUMBER REQUEST for local help."
                    );
                }
                if page.next_after.is_some() {
                    println!("Use /apps next for more apps.");
                }
                self.page = Some(page);
                return Ok(());
            }
            _ => {}
        }
        let (number, date, request) = app_request(input)
            .context("Use /apps, then /app NUMBER [--date YYYY-MM-DD] [REQUEST]")?;
        let Some(app) = number
            .checked_sub(1)
            .and_then(|index| self.page.as_ref()?.items.get(index))
        else {
            bail!("Choose an app number from /apps.");
        };
        let context = space
            .local_record_context(bot_id, &app.pin, date)
            .await
            .map_err(auth_hint)?;
        print_context(&context, date);
        if request.is_empty() {
            return Ok(());
        }
        if self.approved.is_some() {
            bail!(
                "Use /app retry to finish the approved save or /app discard to stop retrying it."
            );
        }
        let result = suggest_app_record(cli, &model, &context, date, request)
            .await
            .map_err(anyhow::Error::msg)?;
        println!("Local answer > {}", result.answer.escape_debug());
        if let Some(values) = result.addition {
            println!(
                "Proposed addition to {}:",
                context.app.plugin_name.escape_debug()
            );
            print_values(&context, &values);
            if prompt("Type save to approve this addition (Enter to skip): ")
                .await?
                .as_deref()
                == Some("save")
            {
                self.approved = Some(ApprovedAddition {
                    pin: context.app.pin,
                    id: Uuid::new_v4(),
                    values,
                });
                self.save(space, bot_id).await?;
            }
        }
        Ok(())
    }

    async fn save(&mut self, space: &SpaceFeatures<'_>, bot_id: &str) -> Result<()> {
        let Some(addition) = &self.approved else {
            println!("No approved app addition is waiting to be saved.");
            return Ok(());
        };
        let operation = addition.id.to_string();
        let save =
            || space.add_local_app_record(bot_id, &addition.pin, &operation, &addition.values);
        let result = match save().await {
            Err(error) if error.is_retryable() => save().await,
            result => result,
        };
        match result {
            Ok(_) => {
                self.approved = None;
                println!("Record saved.");
                Ok(())
            }
            Err(
                error @ Error::Server {
                    status: 400 | 403 | 409,
                    ..
                },
            ) => {
                self.approved = None;
                Err(auth_hint(error)).context("The server rejected the app addition")
            }
            Err(error) => Err(auth_hint(error)).context(
                "Could not confirm the app save. Use /app retry in this session to retry it",
            ),
        }
    }
}

fn app_request(input: &str) -> Option<(usize, Option<&str>, &str)> {
    let (command, args) = split_word(input);
    if command != "/app" {
        return None;
    }
    let (number, rest) = split_word(args);
    let (flag, tail) = split_word(rest);
    if flag == "--date" {
        let (date, request) = split_word(tail);
        return Some((number.parse().ok()?, Some(date), request));
    }
    Some((number.parse().ok()?, None, rest))
}

fn split_word(input: &str) -> (&str, &str) {
    let (word, rest) = input.split_once(char::is_whitespace).unwrap_or((input, ""));
    (word, rest.trim_start())
}

fn print_context(context: &AppContext, date: Option<&str>) {
    println!(
        "{} ({})",
        context.app.plugin_name.escape_debug(),
        context.app.part.id
    );
    if let Some(date) = date {
        println!("Date filter: {}", date.escape_debug());
    }
    if context.items.is_empty() {
        println!("No records in this preview.");
    }
    for (index, record) in context.items.iter().enumerate() {
        println!("Record {}:", index + 1);
        print_values(context, &record.values);
    }
    if let Some(total) = context.total {
        let label = context
            .app
            .part
            .fields
            .iter()
            .find(|field| Some(&field.id) == context.app.part.summary_field.as_ref())
            .map_or("Value", |field| field.label.as_str());
        println!("{} total: {total}", label.escape_debug());
    }
    if context.has_more {
        println!("More records are available in the app.");
    }
}

fn print_values(context: &AppContext, values: &AppValues) {
    for field in &context.app.part.fields {
        let Some(value) = values.get(&field.id) else {
            continue;
        };
        let display = match value {
            AppValue::Text(text) => format!("{text:?}"),
            AppValue::Number(number) => number.to_string(),
        };
        println!("  {} ({}): {display}", field.label.escape_debug(), field.id);
    }
}
