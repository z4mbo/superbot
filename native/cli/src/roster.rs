use std::{collections::HashSet, fs, path::Path};

use anyhow::{ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use superbot_client::Client;
use superbot_features::{CreateBot, Features};

pub fn read(path: &Path) -> Result<Vec<String>> {
    let contents = fs::read(path).with_context(|| format!("Read roster {}", path.display()))?;
    parse(&contents)
}

fn parse(contents: &[u8]) -> Result<Vec<String>> {
    let roster: Value = serde_json::from_slice(contents).context("Read roster JSON")?;
    let entries = roster
        .get("names")
        .and_then(Value::as_array)
        .context("Expected a JSON object with a names array")?;
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let name = entry
            .as_str()
            .with_context(|| format!("Name {} must be text", index + 1))?
            .trim();
        ensure!(
            !name.is_empty()
                && name.encode_utf16().count() <= 80
                && !name.chars().any(char::is_control),
            "Name {} must be one line with 1 to 80 UTF-16 units",
            index + 1
        );
        if seen.insert(name.to_lowercase()) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::json;

    #[test]
    fn duplicate_names_preserve_the_first_spelling_and_order() {
        let document = json!({ "names": [" Ada ", "Milo", "ADA", "milo"] }).to_string();
        assert_eq!(parse(document.as_bytes()).unwrap(), ["Ada", "Milo"]);
    }

    #[test]
    fn validation_matches_the_server_utf16_length_before_importing() {
        let valid = "🌱".repeat(40);
        assert!(parse(json!({ "names": [&valid] }).to_string().as_bytes()).is_ok());
        for invalid in [format!("{valid}a"), "a\nb".to_owned()] {
            assert!(parse(
                json!({ "names": ["Valid", invalid] })
                    .to_string()
                    .as_bytes()
            )
            .is_err());
        }
    }
}

pub async fn import(
    client: Client,
    destination: &str,
    names: Vec<String>,
    dry_run: bool,
) -> Result<()> {
    let space = crate::workspaces::resolve_space(&client, destination).await?;
    let service = Features::new(client);
    let api = service.space(space.id.clone());
    let active = api.list_bots().await?;
    let archived = api.list_archived_bots().await?;
    let existing: HashSet<_> = active
        .iter()
        .chain(&archived)
        .map(|bot| bot.name.trim().to_lowercase())
        .collect();
    let total = names.len();
    let missing: Vec<_> = names
        .into_iter()
        .filter(|name| !existing.contains(&name.to_lowercase()))
        .collect();
    println!(
        "Space {} ({}): {} existing, {} to import.",
        super::terminal_text(&space.name),
        super::terminal_text(&space.id),
        total - missing.len(),
        missing.len()
    );
    for name in &missing {
        if dry_run {
            println!("  {}", super::terminal_text(name));
            continue;
        }
        let key = format!(
            "superbot:roster:{:x}",
            Sha256::digest(name.to_lowercase().as_bytes())
        );
        api.create_bot(&CreateBot {
            name,
            spawn_key: Some(&key),
            ..Default::default()
        })
        .await
        .with_context(|| {
            format!(
                "Import {}. Rerun the command to resume.",
                super::terminal_text(name)
            )
        })?;
    }
    if !dry_run {
        println!("Roster import complete.");
    }
    Ok(())
}
