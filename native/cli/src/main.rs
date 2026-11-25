#[cfg(test)]
mod approval_tests;
mod approvals;
#[cfg(test)]
mod command_tests;
mod local_app_chat;
mod local_chat;
mod roster;
mod send;
mod stream;
#[cfg(test)]
mod test_fixture;
mod threads;
mod tui;
mod workspaces;

use std::{
    io::{self, IsTerminal, Write},
    process::ExitCode,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use serde_json::json;
use superbot_client::{
    remember_server, selected_server, Agent, Client, CredentialStore, Error, MessageAuthor,
    SavedSession, SendReceipt, SignUpResult, Space,
};
use superbot_features::{Features, SpaceFeatures, ThreadSnapshot, ThreadTarget};
use uuid::Uuid;

use stream::{LinePrinter, Reply, RunEnd, Sink, Update};

#[derive(Parser)]
#[command(version, about = "Chat with your Superbot agents")]
struct Args {
    #[arg(long, env = "SUPERBOT_SERVER", global = true)]
    server: Option<String>,
    #[arg(
        long,
        env = "SUPERBOT_SPACE",
        help = "Select a space by name",
        global = true
    )]
    space: Option<String>,
    #[arg(long, help = "Print JSON instead of text", global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(value_name = "AGENT", help = "Open a chat by agent name")]
    agent: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Show the current server or save a default for the app and both commands
    Server { url: Option<String> },
    /// Create an account on the selected server
    Signup,
    /// Sign in and save the session on this device
    Login {
        #[arg(long)]
        email: Option<String>,
        #[arg(long, help = "Sign in with a one-time email code")]
        code: bool,
        #[arg(
            long,
            requires = "email",
            conflicts_with = "code",
            help = "Read the password from standard input"
        )]
        password_stdin: bool,
    },
    /// Revoke and remove the saved session for this server
    Logout,
    /// Show the signed-in account on this server
    Whoami,
    /// List available spaces and agents
    List,
    /// Send one message and print the reply as it streams
    Send {
        agent: String,
        /// The message; read from standard input when left out
        message: Vec<String>,
        #[arg(long, conflicts_with = "conversation")]
        new_conversation: bool,
        #[arg(long, value_name = "THREAD_ID")]
        conversation: Option<String>,
    },
    /// List an agent's conversations or print one
    #[command(subcommand)]
    Threads(threads::ThreadsCommand),
    /// List the approvals waiting on you, or answer one
    Approvals {
        #[command(subcommand)]
        command: Option<approvals::ApprovalCommand>,
    },
    /// Open the full-screen chat
    Tui,
    /// Create, join, and manage workspaces
    #[command(subcommand)]
    Workspaces(workspaces::WorkspaceCommand),
    /// Import agent names from a local JSON file into the selected Space
    ImportBots {
        file: std::path::PathBuf,
        #[arg(long)]
        dry_run: bool,
    },
    /// Open a chat with any agent, including agents named after commands
    Chat {
        agent: String,
        #[arg(long, conflicts_with = "conversation")]
        new_conversation: bool,
        #[arg(long, value_name = "THREAD_ID")]
        conversation: Option<String>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let result = tokio::select! {
        result = run(Args::parse()) => result,
        signal = tokio::signal::ctrl_c() => {
            return if signal.is_ok() { ExitCode::from(130) } else { ExitCode::FAILURE };
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        // The command already printed what happened.
        Err(error) if error.is::<Exit>() => {
            ExitCode::from(error.downcast_ref::<Exit>().map_or(1, |exit| exit.0))
        }
        Err(error) => {
            eprintln!("superbot: {}", terminal_text(&format!("{error:#}")));
            ExitCode::FAILURE
        }
    }
}

/// Ends the command with this exit status once its output is printed.
#[derive(Debug)]
pub(crate) struct Exit(pub(crate) u8);

impl std::fmt::Display for Exit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "exit status {}", self.0)
    }
}

impl std::error::Error for Exit {}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

async fn run(args: Args) -> Result<()> {
    let server = match &args.command {
        Some(Command::Server { url: Some(url) }) => url.trim().to_owned(),
        _ => selected_server(args.server.as_deref()),
    };
    let client = Client::new(&server)?;
    let (agent_name, new_conversation, conversation) = match args.command {
        Some(Command::Server { url }) => {
            if url.is_some() {
                remember_server(&client).context("Could not save the Superbot server address")?;
            }
            println!("{}", terminal_text(client.server()));
            return Ok(());
        }
        Some(Command::Signup) => return signup(&client).await,
        Some(Command::Login {
            email,
            password_stdin: true,
            ..
        }) => return login_from_stdin(&client, email).await,
        Some(Command::Login { email, code, .. }) => return login(&client, email, code).await,
        Some(Command::Logout) => return logout(&client).await,
        Some(Command::Whoami) => return whoami(&connect(&client).await?, args.json).await,
        Some(Command::List) => {
            let client = connect(&client).await?;
            let catalog = discover(&client, args.space.as_deref()).await?;
            if args.json {
                let spaces: Vec<_> = catalog
                    .iter()
                    .map(|(space, agents)| {
                        let agents: Vec<_> = agents
                            .iter()
                            .map(|agent| json!({ "id": agent.id, "name": agent.name }))
                            .collect();
                        json!({ "id": space.id, "name": space.name, "agents": agents })
                    })
                    .collect();
                return print_json(&spaces);
            }
            for (space, agents) in catalog {
                println!("{}", terminal_text(&space.name));
                for agent in agents {
                    println!("  {}", terminal_text(&agent.name));
                }
            }
            return Ok(());
        }
        Some(Command::Send {
            agent,
            message,
            new_conversation,
            conversation,
        }) => {
            let args_space = args.space.as_deref();
            let send = send::SendArgs {
                agent,
                message,
                new_conversation,
                conversation,
            };
            return send::run(&connect(&client).await?, args_space, send, args.json).await;
        }
        Some(Command::Threads(command)) => {
            let client = connect(&client).await?;
            let catalog = discover(&client, args.space.as_deref()).await?;
            let features = Features::new(client.clone());
            return match command {
                threads::ThreadsCommand::List { agent } => {
                    let (space, agent) = find_agent(&catalog, &agent)?;
                    let rows = threads::conversations(&features.space(&space.id), agent).await?;
                    threads::print_conversations(&rows, args.json)
                }
                threads::ThreadsCommand::Show { agent, thread_id } => {
                    let (space, agent) = find_agent(&catalog, &agent)?;
                    let space = features.space(&space.id);
                    threads::show(&space, agent, thread_id.as_deref(), args.json).await
                }
            };
        }
        Some(Command::Tui) => {
            return tui::run(connect(&client).await?, args.space.as_deref()).await;
        }
        Some(Command::Approvals { command }) => {
            let client = connect(&client).await?;
            let catalog = discover(&client, args.space.as_deref()).await?;
            return approvals::run(&Features::new(client), &catalog, command, args.json).await;
        }
        Some(Command::Workspaces(command)) => {
            return workspaces::run(
                client,
                args.server.is_some(),
                args.space.as_deref(),
                command,
            )
            .await;
        }
        Some(Command::ImportBots { file, dry_run }) => {
            let destination = args
                .space
                .as_deref()
                .context("Choose the destination with --space NAME or --space ID")?;
            let names = roster::read(&file)?;
            return roster::import(connect(&client).await?, destination, names, dry_run).await;
        }
        Some(Command::Chat {
            agent,
            new_conversation,
            conversation,
        }) => (Some(agent), new_conversation, conversation),
        None => (args.agent, false, None),
    };
    let client = connect(&client).await?;
    let catalog = discover(&client, args.space.as_deref()).await?;
    let me: serde_json::Value = client
        .rpc("me", None, serde_json::json!({}))
        .await
        .map_err(auth_hint)?;
    let account = me
        .get("userId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if let Some(name) = agent_name {
        let (space, agent) = find_agent(&catalog, &name)?;
        let conversation = if new_conversation {
            let created = client
                .create_bot_conversation(&space.id, &agent.id)
                .await
                .map_err(auth_hint)?;
            println!("Conversation {}", terminal_text(&created.thread_id));
            Some(created.thread_id)
        } else {
            conversation
        };
        chat(&client, account, space, agent, conversation.as_deref()).await?;
    } else {
        loop {
            let options: Vec<_> = catalog
                .iter()
                .flat_map(|(space, agents)| agents.iter().map(move |agent| (space, agent)))
                .collect();
            if options.is_empty() {
                bail!("No agents found. Create an agent in this workspace first.");
            }
            println!("Choose an agent");
            for (index, (space, agent)) in options.iter().enumerate() {
                println!(
                    "  {}. {} / {}",
                    index + 1,
                    terminal_text(&space.name),
                    terminal_text(&agent.name)
                );
            }
            let Some(selection) = prompt("Agent number (Enter to quit): ").await? else {
                break;
            };
            if selection.trim().is_empty() {
                break;
            }
            let Some((space, agent)) = selection
                .trim()
                .parse::<usize>()
                .ok()
                .and_then(|number| number.checked_sub(1))
                .and_then(|index| options.get(index))
            else {
                eprintln!("Choose a number from 1 to {}.", options.len());
                continue;
            };
            if !chat(&client, account, space, agent, None).await? {
                break;
            }
        }
    }
    Ok(())
}

async fn connect(client: &Client) -> Result<Client> {
    if let Some(saved) = CredentialStore::load(client).await? {
        return Ok(saved);
    }
    if !io::stdin().is_terminal() {
        bail!("No saved session for this server. Run superbot login first.");
    }
    login(client, None, false).await?;
    CredentialStore::load(client)
        .await?
        .context("The saved session disappeared. Run superbot login again.")
}

/// Signs in without a terminal, for scripts: the password is the whole of standard input,
/// less one trailing line break.
async fn login_from_stdin(client: &Client, email: Option<String>) -> Result<()> {
    let email = email.context("Give the account with --email")?;
    let password = blocking_input(|| io::read_to_string(io::stdin())).await?;
    let password = password
        .strip_suffix('\n')
        .map(|rest| rest.strip_suffix('\r').unwrap_or(rest))
        .unwrap_or(&password);
    if password.is_empty() {
        bail!("Pipe the password to standard input.");
    }
    let signed_in = client.sign_in(email.trim(), password).await?;
    save_session(&signed_in).await
}

async fn whoami(client: &Client, json: bool) -> Result<()> {
    let me: serde_json::Value = client.rpc("me", None, json!({})).await.map_err(auth_hint)?;
    let text = |key: &str| me[key].as_str().unwrap_or_default().to_owned();
    if json {
        return print_json(&json!({
            "server": client.server(),
            "userId": text("userId"),
            "email": text("email"),
            "name": text("name"),
        }));
    }
    println!(
        "{} <{}>",
        terminal_text(&text("name")),
        terminal_text(&text("email"))
    );
    println!("{}", terminal_text(client.server()));
    Ok(())
}

async fn login(client: &Client, email: Option<String>, code: bool) -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!("Sign-in requires an interactive terminal.");
    }
    let email = match email {
        Some(email) => email,
        None => prompt("Email: ").await?.context("Sign-in cancelled")?,
    };
    if email.trim().is_empty() {
        bail!("Enter your email address.");
    }
    let signed_in = if code {
        client.request_sign_in_code(email.trim()).await?;
        let code = secret("Email code: ").await?;
        client.sign_in_with_code(email.trim(), code.trim()).await?
    } else {
        let password = secret("Password: ").await?;
        client.sign_in(email.trim(), &password).await?
    };
    save_session(&signed_in).await
}

async fn signup(client: &Client) -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!("Account creation requires an interactive terminal.");
    }
    println!("Create an account at {}", client.server());
    let name = prompt("Display name: ")
        .await?
        .context("Signup cancelled")?;
    let email = prompt("Email: ").await?.context("Signup cancelled")?;
    if name.trim().is_empty() || email.trim().is_empty() {
        bail!("Enter a display name and an email address.");
    }
    let password = secret("New password: ").await?;
    if password != secret("Confirm password: ").await? {
        bail!("Passwords differ.");
    }
    match client.sign_up(name.trim(), email.trim(), &password).await? {
        SignUpResult::SignedIn(signed_in) => save_session(&signed_in).await,
        SignUpResult::VerifyEmail => {
            println!("Check your email for the verification link, then run superbot login.");
            Ok(())
        }
    }
}

async fn save_session(signed_in: &Client) -> Result<()> {
    match CredentialStore::save(signed_in).await {
        Ok(SavedSession::SystemStore) => {}
        Ok(SavedSession::File(path)) => eprintln!(
            "No system credential store is available, so the session is saved in {}, readable only by you.",
            path.display()
        ),
        Err(error) => {
            if let Err(revoke_error) = signed_in.sign_out().await {
                eprintln!(
                    "Could not revoke the unsaved session: {}",
                    terminal_text(&revoke_error.to_string())
                );
            }
            return Err(error.into());
        }
    }
    println!("Signed in to {}", signed_in.server());
    Ok(())
}

async fn logout(client: &Client) -> Result<()> {
    let Some(saved) = CredentialStore::load(client).await? else {
        println!("Already signed out.");
        return Ok(());
    };
    match saved.sign_out().await {
        Ok(()) => {}
        Err(error) if error.is_unauthorized() => {}
        Err(error) => {
            return Err(error).context("Sign-out failed. The saved session can be used to retry")
        }
    }
    CredentialStore::delete(client).await?;
    println!("Signed out.");
    Ok(())
}

async fn discover(client: &Client, space_name: Option<&str>) -> Result<Vec<(Space, Vec<Agent>)>> {
    let mut spaces = client.list_spaces().await.map_err(auth_hint)?;
    if let Some(name) = space_name {
        spaces.retain(|space| name_matches(&space.name, name));
        match spaces.len() {
            0 => bail!("No space named {name:?}. Run superbot list to see available spaces."),
            1 => {}
            _ => bail!("More than one space is named {name:?}. Use the picker to choose one."),
        }
    }
    let mut catalog = Vec::with_capacity(spaces.len());
    for space in spaces {
        let agents = client.list_agents(&space.id).await.map_err(auth_hint)?;
        catalog.push((space, agents));
    }
    Ok(catalog)
}

fn find_agent<'a>(
    catalog: &'a [(Space, Vec<Agent>)],
    name: &str,
) -> Result<(&'a Space, &'a Agent)> {
    let candidates = || {
        catalog
            .iter()
            .flat_map(|(space, agents)| agents.iter().map(move |agent| (space, agent)))
    };
    let choose = |exact: bool| -> Result<Option<(&Space, &Agent)>> {
        let mut matches = candidates().filter(|(_, agent)| {
            if exact {
                agent.name == name
            } else {
                name_matches(&agent.name, name)
            }
        });
        let found = matches.next();
        if matches.next().is_some() {
            bail!("More than one agent matches {name:?}. Select its space with --space or use the picker.");
        }
        Ok(found)
    };
    if let Some(exact) = choose(true)? {
        return Ok(exact);
    }
    choose(false)?.with_context(|| {
        format!("No agent named {name:?}. Run superbot list to see available agents.")
    })
}

fn name_matches(candidate: &str, query: &str) -> bool {
    candidate == query || candidate.to_lowercase() == query.to_lowercase()
}

fn auth_hint(error: Error) -> anyhow::Error {
    if error.is_unauthorized() {
        anyhow::Error::new(error)
            .context("Session expired or rejected. Run superbot login for this server")
    } else {
        error.into()
    }
}

async fn chat(
    client: &Client,
    account: &str,
    space: &Space,
    agent: &Agent,
    conversation: Option<&str>,
) -> Result<bool> {
    let mut local = local_chat::LocalChat::open(client, account, space, agent, conversation);
    let features = Features::new(client.clone());
    let thread = ChatThread {
        space: features.space(&space.id),
        agent,
        conversation,
        interactive: io::stdin().is_terminal() && io::stdout().is_terminal(),
    };
    let snapshot = thread
        .space
        .thread(thread.target())
        .await
        .map_err(auth_hint)?;
    if conversation.is_some_and(|id| id != snapshot.thread_id) {
        bail!("The server did not open the requested conversation.");
    }
    let mut cursor = snapshot.cursor;
    let mut read_approval = || prompt("Approval (Enter to leave pending): ");
    println!(
        "{} / {}",
        terminal_text(&space.name),
        terminal_text(&agent.name)
    );
    for message in &snapshot.messages {
        print_message(
            agent,
            &message.role,
            message.author.as_ref(),
            &approvals::message_text(message),
        );
    }
    let pending = local
        .as_ref()
        .map(|chat| chat.has_pending())
        .transpose()?
        .unwrap_or(false);
    let model = if pending {
        None
    } else {
        local
            .as_ref()
            .map(|chat| chat.selection())
            .transpose()?
            .flatten()
    };
    if pending {
        println!("A local message is waiting to be saved. Type /retry to save it.");
    } else if model.is_none() {
        resume_waiting(&thread, &snapshot, &mut cursor, &mut read_approval).await?;
    }
    println!("Type a message and press Enter. /back returns to the picker. /quit exits.");
    if model
        .as_ref()
        .is_some_and(superbot_features::local_app_records::supports_app_assistance)
    {
        println!("Type /apps to see record apps granted to this agent.");
    }
    loop {
        let Some(input) = prompt("You > ").await? else {
            return Ok(false);
        };
        match input.trim() {
            "" => continue,
            "/quit" => return Ok(false),
            "/back" => return Ok(true),
            _ => {}
        }
        if let Some(local) = &mut local {
            match local.handle(client, &thread, input.trim()).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) if thread.interactive => {
                    eprintln!("{}", terminal_text(&format!("{error:#}")));
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        if local_app_chat::is_command(input.trim()) {
            eprintln!("App assistance requires a selected prompt-only local model.");
            continue;
        }
        let nonce = Uuid::new_v4().to_string();
        let message = superbot_features::SendMessage {
            text: Some(&input),
            client_nonce: Some(&nonce),
            ..Default::default()
        };
        let send = || thread.space.send(thread.target(), &message);
        let result = match send().await {
            Err(error) if error.is_retryable() => send().await,
            result => result,
        };
        let receipt = match result {
            Ok(receipt) => receipt,
            Err(error) if error.is_unauthorized() => return Err(auth_hint(error)),
            Err(error) => {
                eprintln!(
                    "Could not send the message. {}",
                    terminal_text(&error.to_string())
                );
                continue;
            }
        };
        println!("Waiting for {}…", terminal_text(&agent.name));
        let SendReceipt {
            run_id,
            run_ids,
            seq,
            ..
        } = receipt;
        let runs = if run_ids.is_empty() {
            vec![run_id]
        } else {
            run_ids
        };
        follow_reply(&thread, &mut cursor, runs, Some(seq), &mut read_approval).await?;
    }
}

async fn resume_waiting(
    thread: &ChatThread<'_>,
    snapshot: &ThreadSnapshot,
    cursor: &mut i64,
    read_approval: &mut impl AsyncFnMut() -> Result<Option<String>>,
) -> Result<()> {
    let mut resumed = Vec::new();
    for run_id in approvals::waiting_runs(snapshot) {
        if matches!(
            thread.offer(snapshot, run_id, read_approval).await?,
            approvals::Outcome::Answered
        ) {
            resumed.push(run_id.to_owned());
        }
    }
    follow_reply(thread, cursor, resumed, None, read_approval).await
}

async fn follow_reply(
    thread: &ChatThread<'_>,
    cursor: &mut i64,
    mut runs: Vec<String>,
    sent_seq: Option<i64>,
    read_approval: &mut impl AsyncFnMut() -> Result<Option<String>>,
) -> Result<()> {
    let mut reply = Reply::default();
    let mut printer = LinePrinter::new(io::stdout(), &thread.agent.name, true);
    while !runs.is_empty() {
        let waiting = tokio::time::timeout(
            Duration::from_secs(600),
            follow_until_waiting(
                thread,
                cursor,
                &mut runs,
                sent_seq,
                &mut reply,
                &mut printer,
            ),
        )
        .await;
        let run_id = match waiting {
            Ok(Ok(Some(run_id))) => run_id,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(error))
                if error
                    .downcast_ref::<Error>()
                    .is_some_and(Error::is_unauthorized) =>
            {
                return Err(error);
            }
            Ok(Err(error)) => {
                eprintln!("{}", terminal_text(&format!("{error:#}")));
                return Ok(());
            }
            Err(_) => {
                eprintln!(
                    "Still waiting after 10 minutes. Reopen the chat to see its latest messages."
                );
                return Ok(());
            }
        };
        let outcome = match thread.space.thread(thread.target()).await {
            Ok(snapshot) => thread.offer(&snapshot, &run_id, read_approval).await?,
            Err(error) if error.is_unauthorized() => return Err(auth_hint(error)),
            Err(error) => {
                eprintln!(
                    "Could not load the approval. {}",
                    terminal_text(&error.to_string())
                );
                approvals::Outcome::LeftPending
            }
        };
        match outcome {
            approvals::Outcome::LeftPending => runs.retain(|id| *id != run_id),
            approvals::Outcome::Answered | approvals::Outcome::Stale => {}
        }
    }
    Ok(())
}

struct ChatThread<'a> {
    space: SpaceFeatures<'a>,
    agent: &'a Agent,
    conversation: Option<&'a str>,
    interactive: bool,
}

impl ChatThread<'_> {
    fn target(&self) -> ThreadTarget<'_> {
        match self.conversation {
            Some(thread_id) => ThreadTarget::BotConversation {
                bot_id: &self.agent.id,
                thread_id,
            },
            None => ThreadTarget::Bot(&self.agent.id),
        }
    }

    async fn offer(
        &self,
        snapshot: &ThreadSnapshot,
        run_id: &str,
        read: &mut impl AsyncFnMut() -> Result<Option<String>>,
    ) -> Result<approvals::Outcome> {
        match approvals::offer(
            &self.space,
            self.target(),
            snapshot,
            run_id,
            self.interactive,
            read,
        )
        .await
        {
            Ok(outcome) => Ok(outcome),
            Err(error) if error.is_unauthorized() => Err(auth_hint(error)),
            Err(error) => {
                eprintln!(
                    "Could not answer the approval. {}",
                    terminal_text(&error.to_string())
                );
                Ok(approvals::Outcome::LeftPending)
            }
        }
    }
}

/// Follows the thread until every pending run ends or one waits for an answer, which it returns.
pub(crate) async fn follow_until_waiting(
    thread: &ChatThread<'_>,
    cursor: &mut i64,
    pending: &mut Vec<String>,
    sent_seq: Option<i64>,
    reply: &mut Reply,
    printer: &mut dyn Sink,
) -> Result<Option<String>> {
    let mut reconnects = 0;
    loop {
        match thread
            .space
            .subscribe_thread(thread.target(), *cursor)
            .await
        {
            Ok(mut stream) => {
                while let Some(event) = stream.next().await {
                    let event = match event {
                        Ok(event) => event,
                        Err(error) if error.is_retryable() => break,
                        Err(error) => return Err(auth_hint(error)),
                    };
                    if event.kind == "heartbeat" || event.seq <= *cursor {
                        continue;
                    }
                    *cursor = event.seq;
                    reconnects = 0;
                    for update in reply.apply(&event)? {
                        let shown = match &update {
                            Update::Message(message) => {
                                message.role == "bot"
                                    || (message.role == "user" && Some(message.seq) != sent_seq)
                            }
                            Update::RunEnded { run_id, .. } => pending.contains(run_id),
                            _ => true,
                        };
                        if !shown {
                            continue;
                        }
                        printer.update(&update)?;
                        let Update::RunEnded { run_id, end } = update else {
                            continue;
                        };
                        if end == RunEnd::WaitingInput {
                            return Ok(Some(run_id));
                        }
                        pending.retain(|id| *id != run_id);
                        if pending.is_empty() {
                            return Ok(None);
                        }
                    }
                }
            }
            Err(error) if error.is_retryable() => {}
            Err(error) => return Err(auth_hint(error)),
        }
        if reconnects >= 3 {
            bail!("The reply stream disconnected. Reopen the chat to see its latest messages.");
        }
        reconnects += 1;
        tokio::time::sleep(Duration::from_millis(300 * reconnects)).await;
    }
}

fn print_message(agent: &Agent, role: &str, author: Option<&MessageAuthor>, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let name = stream::speaker(&agent.name, role, author);
    println!("{} > {}", terminal_text(name), terminal_text(text));
}

fn terminal_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .collect()
}

async fn secret(label: &'static str) -> Result<String> {
    blocking_input(move || rpassword::prompt_password(label)).await
}

async fn prompt(label: &'static str) -> Result<Option<String>> {
    blocking_input(move || {
        print!("{label}");
        io::stdout().flush()?;
        let mut input = String::new();
        let count = io::stdin().read_line(&mut input)?;
        Ok((count != 0).then(|| input.trim_end_matches(['\r', '\n']).to_owned()))
    })
    .await
}

async fn blocking_input<T: Send + 'static>(
    input: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T> {
    let (send, receive) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = send.send(input());
    });
    Ok(receive.await.context("Terminal input stopped")??)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_chat_and_reserved_names_parse() {
        assert_eq!(
            Args::try_parse_from(["superbot", "Research agent"])
                .unwrap()
                .agent
                .as_deref(),
            Some("Research agent")
        );
        assert!(
            matches!(Args::try_parse_from(["superbot", "chat", "login"]).unwrap().command, Some(Command::Chat { agent, conversation: None, new_conversation: false }) if agent == "login")
        );
    }

    #[test]
    fn duplicate_agent_names_require_a_choice() {
        let catalog = ["One", "Two"]
            .into_iter()
            .map(|name| {
                (
                    Space {
                        id: name.into(),
                        name: name.into(),
                        shared: false,
                    },
                    vec![Agent {
                        id: name.into(),
                        name: "Research".into(),
                    }],
                )
            })
            .collect::<Vec<_>>();
        assert!(find_agent(&catalog, "research").is_err());
        assert_eq!(find_agent(&catalog[..1], "research").unwrap().0.name, "One");
    }

    #[test]
    fn strips_terminal_controls() {
        assert_eq!(
            terminal_text("a\u{1b}]52;payload\u{7}\r\nb"),
            "a]52;payload\nb"
        );
    }
}
