use anyhow::{Context, Result, bail};
use clap::Subcommand;
use serde_json::json;
use superbot_client::{Client, CredentialStore, Space};
use superbot_features::{Features, SpaceRole};

use crate::{connect, terminal_text};

#[derive(Subcommand)]
pub(crate) enum WorkspaceCommand {
    /// List the workspaces on this account
    List,
    /// Create a workspace with you as its only member
    Create { name: String },
    /// Create a single-use invite link for the selected workspace
    Invite,
    /// Join the workspace in a Superbot invite link
    Join { link: String },
    /// List the members and roles in the selected workspace
    Members,
    /// Leave the selected shared workspace
    Leave,
}

fn invite_parts(link: &str) -> Result<(&str, &str)> {
    let (origin, token) = link
        .trim()
        .rsplit_once("/invite/")
        .context("Use the full Superbot workspace invite link")?;
    if !(1..=200).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("The workspace invite link is invalid");
    }
    Ok((origin, token))
}

pub(crate) async fn run(
    client: Client,
    override_server: bool,
    space: Option<&str>,
    command: WorkspaceCommand,
) -> Result<()> {
    if let WorkspaceCommand::Join { link } = command {
        let (origin, token) = invite_parts(&link)?;
        let invited_server =
            Client::new(origin).context("The invite must use a Superbot server origin")?;
        if override_server && invited_server.server() != client.server() {
            bail!("The invite is for a different Superbot server");
        }
        let signed_in = CredentialStore::load(&invited_server)
            .await?
            .with_context(|| {
                format!(
                    "Sign in first with superbot --server {} login",
                    invited_server.server()
                )
            })?;
        let features = Features::new(signed_in);
        let preview = features.preview_space_invite(token).await?;
        let id = if preview.already_member {
            preview.space_id
        } else {
            features.accept_space_invite(token).await?
        };
        println!(
            "{}\t{}",
            terminal_text(&id),
            terminal_text(&preview.space_name)
        );
        return Ok(());
    }
    let client = connect(&client).await?;
    match command {
        WorkspaceCommand::List => {
            for space in client.list_spaces().await? {
                println!(
                    "{}\t{}",
                    terminal_text(&space.id),
                    terminal_text(&space.name)
                );
            }
        }
        WorkspaceCommand::Create { name } => {
            let scope = match space {
                Some(name) => Some(resolve_space(&client, name).await?.id),
                None => None,
            };
            let created: Space = client
                .rpc(
                    "spaces/create",
                    scope.as_deref(),
                    json!({ "name": name.trim() }),
                )
                .await?;
            println!(
                "{}\t{}",
                terminal_text(&created.id),
                terminal_text(&created.name)
            );
        }
        WorkspaceCommand::Invite | WorkspaceCommand::Members | WorkspaceCommand::Leave => {
            let name = space.context("Choose the workspace with --space NAME or --space ID")?;
            let space = resolve_space(&client, name).await?;
            let features = Features::new(client);
            let api = features.space(space.id);
            match command {
                WorkspaceCommand::Invite => {
                    println!("{}", terminal_text(&api.create_invite(None).await?.url))
                }
                WorkspaceCommand::Members => {
                    for member in api.members().await?.members {
                        let role = match member.role {
                            SpaceRole::Owner => "owner",
                            SpaceRole::Member => "member",
                        };
                        println!("{role}\t{}", terminal_text(&member.person.name));
                    }
                }
                WorkspaceCommand::Leave => {
                    api.leave().await?;
                    println!("Left {}", terminal_text(&space.name));
                }
                _ => unreachable!(),
            }
        }
        WorkspaceCommand::Join { .. } => unreachable!(),
    }
    Ok(())
}

pub(crate) async fn resolve_space(client: &Client, name: &str) -> Result<Space> {
    let spaces = client.list_spaces().await?;
    if let Some(space) = spaces.iter().find(|space| space.id == name) {
        return Ok(space.clone());
    }
    let mut matches = spaces
        .into_iter()
        .filter(|space| crate::name_matches(&space.name, name));
    let space = matches.next().context("No matching Space on this server")?;
    if matches.next().is_some() {
        bail!("Several Spaces have that name. Use --space with the Space ID.");
    }
    Ok(space)
}
