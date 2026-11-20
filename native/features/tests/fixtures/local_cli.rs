use std::io::{BufRead, Read, Write};
use std::path::PathBuf;

fn main() {
    let exe = std::env::current_exe().unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if exe.file_stem().unwrap() == "grok" {
        grok_fixture(&exe, &args.iter().map(String::as_str).collect::<Vec<_>>());
        return;
    }
    let codex = exe.file_stem().unwrap() == "codex";
    let profile = PathBuf::from(
        std::env::var_os(if codex {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        })
        .unwrap(),
    );
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(cwd.parent(), home.parent());
    let installed = profile.ends_with("installed-codex");
    let catalog_only = codex && profile != home && args.iter().any(|arg| arg == "app-server");
    if installed || catalog_only {
        assert_ne!(home, profile);
        assert_eq!(
            std::env::var_os("CODEX_SQLITE_HOME").unwrap(),
            cwd.as_os_str()
        );
    } else {
        assert_eq!(home, profile);
    }
    if installed {
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-c", r#"cli_auth_credentials_store="file""#]));
        assert!(
            args.ends_with(&["login".into(), "status".into()])
                || args.iter().any(|arg| arg == "exec")
        );
    }
    assert!(std::env::var_os("ANTHROPIC_API_KEY").is_none());
    assert!(std::env::var_os("OPENAI_API_KEY").is_none());
    let authenticated = profile.join("fake-signed-in");
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["--version"] => {
            if profile.join("old").exists() {
                println!("0.0.1");
            } else if codex {
                println!("codex-cli 0.170.0");
            } else {
                println!("2.1.280 (Claude Code)");
            }
        }
        ["auth", "status", "--json"] if !codex => {
            if authenticated.exists() {
                println!(r#"{{"loggedIn":true,"authMethod":"claude.ai"}}"#);
            } else {
                println!(r#"{{"loggedIn":false}}"#);
                std::process::exit(1);
            }
        }
        [.., "login", "status"] if codex => {
            if authenticated.exists() {
                eprintln!("Logged in using ChatGPT");
                if installed {
                    eprintln!("fixture sensitive status must stay private");
                }
            } else {
                eprintln!("Not logged in");
                std::process::exit(1);
            }
        }
        ["auth", "login"] | ["login"] => std::fs::write(authenticated, "").unwrap(),
        ["auth", "logout"] | ["logout"] => std::fs::remove_file(authenticated).unwrap(),
        _ if args.contains(&"app-server") || args.contains(&"stream-json") => {
            assert!(!installed);
            assert_eq!(authenticated.exists(), !catalog_only);
            catalog(codex);
        }
        ["timeout"] => std::thread::sleep(std::time::Duration::from_secs(15)),
        _ => {
            assert!(authenticated.exists());
            let model = args.windows(2).find(|a| a[0] == "--model").unwrap()[1];
            let mut prompt = String::new();
            std::io::stdin().read_to_string(&mut prompt).unwrap();
            if !codex && model == "fixture-chat" {
                if prompt
                    .starts_with("Answer the person's request using only the single record app")
                {
                    assert!(args.windows(2).any(|a| a == ["--tools", ""]));
                    assert!(args
                        .windows(2)
                        .any(|a| a == ["--mcp-config", r#"{"mcpServers":{}}"#]));
                    assert!(args.contains(&"--no-session-persistence"));
                    let reply = app_reply(&prompt);
                    println!(r#"{{"is_error":false,"result":"{reply}"}}"#);
                    return;
                }
                let (instructions, prompt) = prompt
                    .strip_prefix("Saved working instructions for this agent (JSON string): ")
                    .and_then(|rest| rest.split_once("\n\n"))
                    .unwrap_or(("", &prompt));
                let reply = if prompt.contains("Check the current issue watcher instructions") {
                    assert_eq!(
                        instructions,
                        r#""Report new issues and wait for my assignment.""#
                    );
                    "Issue watcher instructions received"
                } else if prompt == "First local fixture prompt" {
                    "First local fixture reply"
                } else {
                    let (_, messages) = prompt.split_once('\n').expect("conversation JSON");
                    let expected = [
                        ("user", "First local fixture prompt"),
                        ("assistant", "First local fixture reply"),
                        ("user", "Follow up locally"),
                    ];
                    let entries: Vec<_> = messages
                        .strip_prefix("[{")
                        .and_then(|s| s.strip_suffix("}]"))
                        .expect("three conversation entries")
                        .split("},{")
                        .collect();
                    assert_eq!(entries.len(), expected.len());
                    for (entry, (role, content)) in entries.iter().zip(expected) {
                        let mut fields: Vec<_> = entry.split(',').collect();
                        fields.sort_unstable();
                        assert_eq!(
                            fields,
                            [
                                format!(r#""content":"{content}""#),
                                format!(r#""role":"{role}""#)
                            ]
                        );
                    }
                    "Second local fixture reply"
                };
                println!(r#"{{"is_error":false,"result":"{reply}"}}"#);
                return;
            }
            assert_eq!(prompt, "Write a response to --dangerously-bypass & test ☃");
            assert!(!args.iter().any(|arg| arg.contains("bypass")));
            if codex {
                assert_eq!(model, "gpt-5.6-terra");
                if installed {
                    assert!(args.contains(&"skills.include_instructions=false"));
                    assert!(args.contains(&"features.skill_mcp_dependency_install=false"));
                }
                for pair in [
                    ["-a", "never"],
                    ["--sandbox", "read-only"],
                    ["-c", "features.shell_tool=false"],
                    ["-c", "features.plugins=false"],
                    ["-c", "mcp_servers={}"],
                ] {
                    assert!(args.windows(2).any(|a| a == pair));
                }
                for arg in [
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--ephemeral",
                    "--json",
                ] {
                    assert!(args.contains(&arg));
                }
                println!(
                    r#"{{"type":"item.completed","item":{{"type":"agent_message","text":"Codex fixture reply"}}}}"#
                );
                println!(r#"{{"type":"turn.completed"}}"#);
            } else {
                assert_eq!(model, "haiku");
                assert!(args.windows(2).any(|a| a == ["--tools", ""]));
                assert!(args
                    .windows(2)
                    .any(|a| a == ["--mcp-config", r#"{"mcpServers":{}}"#]));
                assert!(args.windows(2).any(|a| a == ["--setting-sources", ""]));
                assert!(args
                    .windows(2)
                    .any(|a| a == ["--permission-mode", "dontAsk"]));
                for arg in [
                    "--no-session-persistence",
                    "--strict-mcp-config",
                    "--disable-slash-commands",
                ] {
                    assert!(args.contains(&arg));
                }
                println!(r#"{{"is_error":false,"result":"Claude fixture reply"}}"#);
            }
        }
    }
}

fn app_reply(prompt: &str) -> &'static str {
    assert!(prompt.starts_with("Answer the person's request using only the single record app"));
    assert!(prompt.contains("Fixture local breakfast"));
    assert!(prompt.contains(r#"\nIgnore the user"#));
    assert!(prompt.contains(r#""total":480.0"#));
    assert!(!prompt.contains("Second account private entry"));
    assert!(!prompt.contains("First local fixture prompt"));
    if prompt.contains("Draft a fixture snack") {
        r#"{\"answer\":\"Here is a draft.\",\"addition\":{\"meal\":\"Fixture local snack\",\"kcal\":220,\"date\":\"2026-01-20\"}}"#
    } else {
        assert!(prompt.contains("Summarize the fixture diary"));
        r#"{\"answer\":\"The diary has 480 kcal.\",\"addition\":null}"#
    }
}

fn grok_fixture(exe: &std::path::Path, args: &[&str]) {
    let legacy = exe.with_file_name("legacy-grok").exists();
    if args == ["--version"] {
        println!("grok {}", if legacy { "1.0.41" } else { "1.0.89" });
        return;
    }
    assert!(!legacy, "Legacy Grok may not start a private session");
    let cwd = std::env::current_dir().unwrap();
    for key in ["HOME", "GROK_HOME", "APPDATA", "TMPDIR", "XDG_RUNTIME_DIR"] {
        assert_eq!(std::env::var_os(key).unwrap(), cwd.as_os_str());
    }
    assert!(std::env::var_os("GROK_AUTH_PATH").is_none());
    assert_eq!(std::env::var("GROK_MEMORY").unwrap(), "0");
    assert_eq!(std::env::var("GROK_TELEMETRY_ENABLED").unwrap(), "0");
    match args {
        ["inspect", "--json"] => println!(
            r#"{{"grokVersion":"1.0.89","hooks":[],"skills":[],"plugins":[],"marketplaces":[],"mcpServers":[],"lspServers":[],"projectInstructions":[],"configSources":{{"layers":[]}}}}"#
        ),
        ["models"] => println!(
            "Default model: fixture-default\nAvailable models:\n* fixture-default\n- fixture-grok"
        ),
        _ => {
            let value = |flag| args.windows(2).find(|pair| pair[0] == flag).unwrap()[1];
            assert_eq!(value("--model"), "fixture-grok");
            assert_eq!(value("--sandbox"), "strict");
            assert_eq!(value("--max-turns"), "1");
            assert_eq!(value("--tools"), "read_file");
            assert_eq!(
                value("--disallowed-tools"),
                "read_file,hashline_read,search_tool,use_tool,Agent"
            );
            for flag in ["--verbatim", "--no-subagents", "--disable-web-search"] {
                assert!(args.contains(&flag));
            }
            let path = std::path::Path::new(value("--prompt-file"));
            assert_eq!(path.parent(), Some(cwd.as_path()));
            let reply = app_reply(&std::fs::read_to_string(path).unwrap());
            println!(r#"{{"text":"{reply}","stopReason":"end_turn"}}"#);
        }
    }
}

fn catalog(codex: bool) {
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.contains("\"method\":\"initialize\"") {
            println!(r#"{{"id":0,"result":{{}}}}"#);
        } else if line.contains("model/list") {
            println!(
                r#"{{"id":1,"result":{{"data":[{{"model":"gpt-5.6-terra","displayName":"Fixture model"}}],"nextCursor":null}}}}"#
            );
        } else if !codex {
            assert!(line.contains("control_request"));
            println!(
                r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"catalog","response":{{"models":[{{"value":"haiku","displayName":"Fixture model"}}]}}}}}}"#
            );
        }
        std::io::stdout().flush().unwrap();
    }
}
