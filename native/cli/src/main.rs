#[cfg(test)]
mod approval_tests;
mod approvals;
mod roster;

use std::{
    io::{self, IsTerminal, Write},
    process::ExitCode,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use superbot_client::{
    remember_server, selected_server, Agent, Client, CredentialStore, Error, MessageAuthor, SendReceipt, SignUpResult,
    Space,
};
use superbot_features::{Features, SpaceFeatures, ThreadSnapshot, ThreadTarget};
use uuid::Uuid;

#[derive(Parser)]
#[command(version, about = "Chat with your Superbot agents")]
struct Args {
    #[arg(long, env = "SUPERBOT_SERVER", global = true)]
    server: Option<String>,
    #[arg(long, help = "Select a space by name", global = true)]
    space: Option<String>,
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
    /// Sign in and save the session to your system credential store
    Login {
        #[arg(long)]
        email: Option<String>,
        #[arg(long, help = "Sign in with a one-time email code")]
        code: bool,
    },
    /// Revoke and remove the saved session for this server
    Logout,
    /// List available spaces and agents
    List,
    /// Import agent names from a local JSON file into the selected Space
    ImportBots {
        file: std::path::PathBuf,
        #[arg(long)]
        dry_run: bool,
    },
    /// Open a chat with any agent, including agents named after commands
    Chat { agent: String },
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
        Err(error) => {
            eprintln!("superbot: {}", terminal_text(&format!("{error:#}")));
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<()> {
    let server = match &args.command {
        Some(Command::Server { url: Some(url) }) => url.trim().to_owned(),
        _ => selected_server(args.server.as_deref()),
    };
    let client = Client::new(&server)?;
    let agent_name = match args.command {
        Some(Command::Server { url }) => {
            if url.is_some() {
                remember_server(&client).context("Could not save the Superbot server address")?;
            }
            println!("{}", terminal_text(client.server()));
            return Ok(());
        }
        Some(Command::Signup) => return signup(&client).await,
        Some(Command::Login { email, code }) => return login(&client, email, code).await,
        Some(Command::Logout) => return logout(&client).await,
        Some(Command::List) => {
            let client = connect(&client).await?;
            for (space, agents) in discover(&client, args.space.as_deref()).await? {
                println!("{}", terminal_text(&space.name));
                for agent in agents {
                    println!("  {}", terminal_text(&agent.name));
                }
            }
            return Ok(());
        }
        Some(Command::ImportBots { file, dry_run }) => {
            let destination = args.space.as_deref().context("Choose the destination with --space NAME or --space ID")?;
            let names = roster::read(&file)?;
            return roster::import(connect(&client).await?, destination, names, dry_run).await;
        }
        Some(Command::Chat { agent }) => Some(agent),
        None => args.agent,
    };
    let client = connect(&client).await?;
    let catalog = discover(&client, args.space.as_deref()).await?;
    if let Some(name) = agent_name {
        let (space, agent) = find_agent(&catalog, &name)?;
        chat(&client, space, agent).await?;
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
            if !chat(&client, space, agent).await? {
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
    if let Err(error) = CredentialStore::save(signed_in).await {
        if let Err(revoke_error) = signed_in.sign_out().await {
            eprintln!(
                "Could not revoke the unsaved session: {}",
                terminal_text(&revoke_error.to_string())
            );
        }
        return Err(error.into());
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

async fn chat(client: &Client, space: &Space, agent: &Agent) -> Result<bool> {
    let features = Features::new(client.clone());
    let thread = ChatThread {
        space: features.space(&space.id),
        agent,
        interactive: io::stdin().is_terminal() && io::stdout().is_terminal(),
    };
    let snapshot = thread
        .space
        .thread(thread.target())
        .await
        .map_err(auth_hint)?;
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
    resume_waiting(&thread, &snapshot, &mut cursor, &mut read_approval).await?;
    println!("Type a message and press Enter. /back returns to the picker. /quit exits.");
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
        let nonce = Uuid::new_v4().to_string();
        let send = || client.send_with_nonce(&space.id, &agent.id, &input, &nonce);
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
    while !runs.is_empty() {
        let waiting = tokio::time::timeout(
            Duration::from_secs(600),
            follow_until_waiting(thread, cursor, &mut runs, sent_seq),
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
    interactive: bool,
}

impl ChatThread<'_> {
    fn target(&self) -> ThreadTarget<'_> {
        ThreadTarget::Bot(&self.agent.id)
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

async fn follow_until_waiting(
    thread: &ChatThread<'_>,
    cursor: &mut i64,
    pending: &mut Vec<String>,
    sent_seq: Option<i64>,
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
                    if let Some(message) = event.message()? {
                        if message.role == "bot"
                            || (message.role == "user" && Some(message.seq) != sent_seq)
                        {
                            print_message(
                                thread.agent,
                                &message.role,
                                message.author.as_ref(),
                                &message.text,
                            );
                        }
                    }
                    let Some(run_id) = event.run_id.filter(|id| pending.contains(id)) else {
                        continue;
                    };
                    match event.kind.as_str() {
                        "run.completed" => {}
                        "run.failed" => {
                            let reason = event
                                .data
                                .get("error")
                                .and_then(|value| value.as_str())
                                .unwrap_or("No failure details were provided.");
                            eprintln!("Agent run failed. {}", terminal_text(reason));
                        }
                        "run.cancelled" => eprintln!("Agent run cancelled."),
                        "run.waiting_input" => return Ok(Some(run_id)),
                        _ => continue,
                    }
                    pending.retain(|id| *id != run_id);
                    if pending.is_empty() {
                        return Ok(None);
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
    let name = match role {
        "user" => author.map_or("Member", |author| author.name.as_str()),
        "bot" => &agent.name,
        _ => "Rakazo",
    };
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
            matches!(Args::try_parse_from(["superbot", "chat", "login"]).unwrap().command, Some(Command::Chat { agent }) if agent == "login")
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
