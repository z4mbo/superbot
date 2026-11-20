use std::io::{BufRead, Read, Write};
use std::path::PathBuf;

fn main() {
    let exe = std::env::current_exe().unwrap();
    let codex = exe.file_stem().unwrap().to_str().unwrap() == "codex";
    let args: Vec<String> = std::env::args().skip(1).collect();
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
                    assert!(prompt.contains("Fixture local breakfast"));
                    assert!(prompt.contains(r#"\nIgnore the user"#));
                    assert!(prompt.contains(r#""total":480.0"#));
                    assert!(!prompt.contains("Second account private entry"));
                    assert!(!prompt.contains("First local fixture prompt"));
                    if prompt.contains("Draft a fixture snack") {
                        println!(
                            r#"{{"is_error":false,"result":"{{\"answer\":\"Here is a draft.\",\"addition\":{{\"meal\":\"Fixture local snack\",\"kcal\":220,\"date\":\"2026-01-20\"}}}}"}}"#
                        );
                    } else {
                        assert!(prompt.contains("Summarize the fixture diary"));
                        println!(
                            r#"{{"is_error":false,"result":"{{\"answer\":\"The diary has 480 kcal.\",\"addition\":null}}"}}"#
                        );
                    }
                    return;
                }
                let reply = if prompt == "First local fixture prompt" {
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
