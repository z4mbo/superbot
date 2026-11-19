mod manifest;
mod scaffold;
#[cfg(test)]
mod tests;

use std::{io, path::PathBuf, process::ExitCode};

use anyhow::{bail, ensure, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::Deserialize;
use serde_json::{json, Value};
use superbot_client::{selected_server, Client, CredentialStore, Error, Space};

#[derive(Parser)]
#[command(version, about = "Develop plugins for the Superbot registry")]
struct Cli {
    #[arg(long, env = "SUPERBOT_SERVER", global = true)]
    server: Option<String>,
    #[arg(long, global = true, help = "Select a Space by exact name or ID")]
    space: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a starter skill or TypeScript MCP app
    #[command(visible_alias = "scaffold")]
    Init {
        slug: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "plugin.json")]
        manifest: PathBuf,
        #[arg(long, value_enum, default_value = "skill")]
        template: scaffold::Template,
    },
    /// Validate a manifest locally
    Validate {
        #[arg(default_value = "plugin.json")]
        manifest: PathBuf,
    },
    /// Submit a new version for review
    #[command(visible_alias = "submit")]
    Publish {
        slug: String,
        #[arg(value_parser = clap::value_parser!(i32).range(1..))]
        version: i32,
        #[arg(long, default_value = "plugin.json")]
        manifest: PathBuf,
    },
    /// List approved versions, your submissions, installations, or the reviewer queue
    List {
        #[arg(value_enum, default_value = "discover")]
        scope: ListScope,
        #[command(flatten)]
        page: PageArgs,
        #[arg(long, help = "Filter approved versions by slug")]
        slug: Option<String>,
        #[arg(long, help = "Search approved versions by slug, name, or description")]
        query: Option<String>,
        #[arg(long, value_enum, help = "Filter the reviewer queue by status")]
        status: Option<Status>,
    },
    /// Look up one of your submitted versions by ID
    Status { version_id: String },
    /// List Space agents and their IDs for grants
    Agents,
    /// Install an approved version in the Space
    Install { version_id: String },
    /// Switch an installation to an approved version and clear all of its grants
    SwitchVersion {
        installation_id: String,
        expected_version_id: String,
        version_id: String,
    },
    /// Replace one agent's grants. Omit part IDs to revoke all grants for that agent
    #[command(visible_alias = "grant")]
    SetGrants {
        installation_id: String,
        bot_id: String,
        part_ids: Vec<String>,
    },
    /// Remove an installation and its grants
    Uninstall { installation_id: String },
    /// Approve or reject a pending submission as a deployment admin
    Review {
        version_id: String,
        #[arg(value_enum)]
        decision: Decision,
        #[arg(long, required_if_eq("decision", "rejected"))]
        reason: Option<String>,
    },
}

#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum ListScope {
    Discover,
    Mine,
    Installations,
    Submissions,
}

#[derive(Clone, Copy, ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Pending,
    Approved,
    Rejected,
}

#[derive(Clone, ValueEnum)]
enum Decision {
    Approved,
    Rejected,
}

#[derive(Args)]
struct PageArgs {
    #[arg(long)]
    after: Option<String>,
    #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=50))]
    limit: u32,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("Error: {}", format!("{error:#}").escape_debug());
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

async fn run(cli: Cli) -> Result<()> {
    let request = match cli.command {
        Command::Init {
            slug,
            name,
            manifest,
            template,
        } => {
            for path in scaffold::write(&manifest, &slug, name, template)? {
                println!("Created {}", path.display());
            }
            return Ok(());
        }
        Command::Validate { manifest } => {
            manifest::read(&manifest)?;
            println!("Manifest is valid");
            return Ok(());
        }
        command => command.request()?,
    };
    let client = Client::new(&selected_server(cli.server.as_deref()))?;
    let client = CredentialStore::load(&client)
        .await?
        .context("No saved session for this server. Run superbot login for the same server")?;
    let spaces = client.list_spaces().await.map_err(auth_error)?;
    let space = select_space(&spaces, cli.space.as_deref())?;
    let result = request.execute(&client, &space.id).await?;
    use io::Write;
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &result)?;
    writeln!(out)?;
    Ok(())
}

enum Request {
    Rpc(&'static str, Value),
    Status(String),
    Agents,
}

impl Command {
    fn request(self) -> Result<Request> {
        let (procedure, input) = match self {
            Self::Init { .. } | Self::Validate { .. } => unreachable!("local commands"),
            Self::Publish {
                slug,
                version,
                manifest,
            } => {
                manifest::check_slug(&slug)?;
                (
                    "pluginRegistry/submit",
                    json!({
                        "slug": slug, "version": version, "manifest": manifest::read(&manifest)?,
                    }),
                )
            }
            Self::List {
                scope,
                page,
                slug,
                query,
                status,
            } => {
                ensure!(
                    slug.is_none() || scope == ListScope::Discover,
                    "--slug requires list discover"
                );
                ensure!(
                    query.is_none() || scope == ListScope::Discover,
                    "--query requires list discover"
                );
                ensure!(
                    status.is_none() || scope == ListScope::Submissions,
                    "--status requires list submissions"
                );
                let mut input = json!({ "limit": page.limit });
                if let Some(after) = page.after {
                    input["after"] = json!(after);
                }
                let procedure = match scope {
                    ListScope::Discover => {
                        if let Some(slug) = slug {
                            manifest::check_slug(&slug)?;
                            input["slug"] = json!(slug);
                        }
                        if let Some(mut query) = query {
                            manifest::trim_text(&mut query, "query", 120)?;
                            input["query"] = json!(query);
                        }
                        "pluginRegistry/discover"
                    }
                    ListScope::Mine => "pluginRegistry/mine",
                    ListScope::Installations => "pluginRegistry/installations",
                    ListScope::Submissions => {
                        if let Some(status) = status {
                            input["status"] = json!(status);
                        }
                        "pluginRegistry/submissions"
                    }
                };
                (procedure, input)
            }
            Self::Status { version_id } => return Ok(Request::Status(version_id)),
            Self::Agents => return Ok(Request::Agents),
            Self::Install { version_id } => {
                ("pluginRegistry/install", json!({ "versionId": version_id }))
            }
            Self::SwitchVersion {
                installation_id,
                expected_version_id,
                version_id,
            } => (
                "pluginRegistry/switchVersion",
                json!({
                    "installationId": installation_id,
                    "expectedVersionId": expected_version_id,
                    "versionId": version_id,
                }),
            ),
            Self::Uninstall { installation_id } => (
                "pluginRegistry/uninstall",
                json!({ "installationId": installation_id }),
            ),
            Self::SetGrants {
                installation_id,
                bot_id,
                part_ids,
            } => {
                ensure!(part_ids.len() <= 16, "Supply at most 16 part IDs");
                for id in &part_ids {
                    manifest::check_slug(id)?;
                }
                (
                    "pluginRegistry/setGrants",
                    json!({
                        "installationId": installation_id, "botId": bot_id, "partIds": part_ids,
                    }),
                )
            }
            Self::Review {
                version_id,
                decision,
                reason,
            } => {
                let input = match decision {
                    Decision::Approved => {
                        ensure!(reason.is_none(), "--reason is only used for rejection");
                        json!({ "versionId": version_id, "decision": "approved" })
                    }
                    Decision::Rejected => {
                        let mut reason = reason.context("Rejection requires --reason")?;
                        manifest::trim_text(&mut reason, "reason", 2000)?;
                        json!({ "versionId": version_id, "decision": "rejected", "reason": reason })
                    }
                };
                ("pluginRegistry/review", input)
            }
        };
        Ok(Request::Rpc(procedure, input))
    }
}

impl Request {
    async fn execute(self, client: &Client, space: &str) -> Result<Value> {
        match self {
            Self::Rpc(path, input) => client
                .rpc(path, Some(space), input)
                .await
                .map_err(auth_error),
            Self::Status(id) => submission_status(client, space, &id).await,
            Self::Agents => {
                let agents = client.list_agents(space).await.map_err(auth_error)?;
                let items = agents
                    .into_iter()
                    .map(|agent| json!({ "id": agent.id, "name": agent.name }))
                    .collect();
                Ok(Value::Array(items))
            }
        }
    }
}

async fn submission_status(client: &Client, space: &str, id: &str) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        items: Vec<Value>,
        next_after: Option<String>,
    }

    let mut seen = std::collections::HashSet::new();
    let mut input = json!({ "limit": 50 });
    loop {
        let page: Page = client
            .rpc("pluginRegistry/mine", Some(space), input)
            .await
            .map_err(auth_error)?;
        if let Some(version) = page.items.into_iter().find(|version| version["id"] == id) {
            return Ok(version);
        }
        let Some(after) = page.next_after else {
            bail!("No submitted version with ID {id}");
        };
        ensure!(
            seen.insert(after.clone()),
            "Registry repeated the pagination cursor"
        );
        input = json!({ "limit": 50, "after": after });
    }
}

fn select_space<'a>(spaces: &'a [Space], selection: Option<&str>) -> Result<&'a Space> {
    if let Some(selection) = selection {
        if let Some(space) = spaces.iter().find(|space| space.id == selection) {
            return Ok(space);
        }
        let mut matches = spaces.iter().filter(|space| space.name == selection);
        let space = matches
            .next()
            .with_context(|| format!("No Space matches {selection:?}"))?;
        ensure!(
            matches.next().is_none(),
            "Multiple Spaces match {selection:?}. Use a Space ID"
        );
        return Ok(space);
    }
    match spaces {
        [space] => Ok(space),
        [] => bail!("Join or create a Space in Rakazo first"),
        _ => {
            let names = spaces
                .iter()
                .map(|space| format!("{:?} ({})", space.name, space.id))
                .collect::<Vec<_>>();
            bail!(
                "Select a Space with --space. Available Spaces: {}",
                names.join(", ")
            )
        }
    }
}

fn auth_error(error: Error) -> anyhow::Error {
    let unauthorized = error.is_unauthorized();
    let error = anyhow::Error::new(error);
    if unauthorized {
        error.context("Session expired or rejected. Run superbot login for the same server")
    } else {
        error
    }
}
