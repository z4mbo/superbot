use super::*;

fn fixture(id: &str, mode: &str) -> (tempfile::TempDir, Engine) {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("fixture.mjs");
    fs::write(&script, include_str!("fixture.mjs")).unwrap();
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").unwrap();
    let executable = std::env::split_paths(&path)
        .find_map(|dir| executable(&dir.join(node)))
        .expect("Node.js is required for the local protocol fixtures");
    let provider = inventory().iter().find(|row| row.id == id).unwrap();
    let engine = Engine {
        provider,
        executable,
        launcher_args: vec![script.into_os_string(), mode.into()],
        args: provider.args.iter().map(OsString::from).collect(),
    };
    (root, engine)
}

#[tokio::test]
async fn acp_catalog_auth_permissions_and_text() {
    let (_root, engine) = fixture("grok", "grok-acp");
    let probe = engine.probe().await.unwrap();
    assert_eq!(probe.models.len(), 2);
    assert_eq!(probe.current_model.as_deref(), Some("one"));
    assert_eq!(probe.models[0].label, "Actual model");
    assert_eq!(probe.models[0].provider.as_deref(), Some("Group"));
    let mut session = engine.connect().await.unwrap();
    assert_eq!(
        session.prompt(Some("two"), "prompt", |_| {}).await,
        Err(Error::Unsafe)
    );
    let mut text = String::new();
    let reply = session
        .prompt(Some("one"), "prompt", |chunk| text.push_str(chunk))
        .await
        .unwrap();
    assert_eq!(reply.text, "ACP reply");
    assert_eq!(reply.text, text);
    assert_eq!(reply.stop_reason, "end_turn");

    let cancel = tokio::time::sleep(Duration::from_millis(100));
    assert_eq!(
        session.prompt_until(None, "hang", |_| {}, cancel).await,
        Err(Error::Cancelled)
    );
    assert_eq!(
        session.prompt(None, "another prompt", |_| {}).await,
        Err(Error::Closed)
    );
}

#[tokio::test]
async fn unsafe_and_signed_out_engines_are_distinguished() {
    let (_root, engine) = fixture("grok", "grok-mcp");
    assert!(!engine.safe_to_run().await.unwrap());

    let (_root, engine) = fixture("cline", "signed-out");
    let probe = engine.probe().await.unwrap();
    assert!(probe.needs_auth);
    assert_eq!(probe.auth_methods[0].id, "browser-auth");
    assert!(!engine.safe_to_run().await.unwrap());
    assert!(matches!(engine.connect().await, Err(Error::Unsafe)));
    assert_eq!(engine.sign_in().await, Err(Error::Unsupported));

    let (_root, engine) = fixture("cursor", "grok-headless");
    assert!(matches!(engine.probe().await, Err(Error::Unsupported)));
    assert_eq!(engine.sign_in().await, Err(Error::Unsupported));

    let (_root, engine) = fixture("mistralVibe", "vibe");
    engine.sign_in().await.unwrap();
}

#[tokio::test]
async fn grok_headless_uses_its_own_model_ids_and_a_scoped_prompt_file() {
    let (_root, engine) = fixture("grok", "grok-headless");
    assert!(engine.safe_to_run().await.unwrap());
    engine.sign_in().await.unwrap();
    let mut session = engine.connect().await.unwrap();
    assert_eq!(session.models()[1].id, "fixture-b");
    let reply = session
        .prompt(Some("fixture-b"), "--always-approve is prompt text", |_| {})
        .await
        .unwrap();
    assert_eq!(reply.text, "headless reply");
    assert_eq!(session.current_model(), Some("fixture-b"));
}

#[tokio::test]
async fn pi_rpc_lists_selects_and_streams_models() {
    let (_root, engine) = fixture("pi", "pi");
    let probe = engine.probe().await.unwrap();
    assert_eq!(probe.current_model.as_deref(), Some("test/one"));
    assert_eq!(probe.models[1].id, "test/two");
    let mut session = engine.connect().await.unwrap();
    assert_eq!(
        session
            .prompt(Some("test/two"), "prompt", |_| {})
            .await
            .unwrap()
            .text,
        "Pi reply"
    );
}

#[tokio::test]
async fn custom_config_is_local_and_never_enables_turns() {
    let (root, fixture) = fixture("custom-acp", "custom");
    assert!(load_custom(root.path()).unwrap().is_none());
    let path = root.path().join("local-acp.json");
    fs::write(&path, r#"{"executable":"relative-command"}"#).unwrap();
    assert!(matches!(
        load_custom(root.path()),
        Err(Error::InvalidLocalConfig)
    ));
    fs::write(
        path,
        serde_json::to_vec(&json!({
            "executable": fixture.executable, "args": fixture.launcher_args.iter().map(|arg| arg.to_str().unwrap()).collect::<Vec<_>>(),
        }))
        .unwrap(),
    )
    .unwrap();
    let engine = load_custom(root.path()).unwrap().unwrap();
    assert_eq!(engine.probe().await.unwrap().models[0].id, "one");
    assert!(!engine.safe_to_run().await.unwrap());
    assert!(matches!(engine.connect().await, Err(Error::Unsafe)));
}

#[tokio::test]
async fn restricted_providers_run_selected_models() {
    for (id, mode, prompt, expected) in [
        ("gemini", "gemini", "/auth", "Gemini reply"),
        #[cfg(any(windows, target_os = "linux"))]
        ("opencodeGo", "opencode", "/auth", "OpenCode reply"),
        (
            "githubCopilot",
            "copilot",
            "--allow-all-tools",
            "Copilot reply",
        ),
    ] {
        let (_root, engine) = fixture(id, mode);
        assert!(engine.safe_to_run().await.unwrap());
        let mut session = engine.connect().await.unwrap();
        assert_eq!(
            session.prompt(Some("missing"), prompt, |_| {}).await,
            Err(Error::UnknownModel)
        );
        let mut streamed = String::new();
        let reply = session
            .prompt(Some("two"), prompt, |chunk| streamed.push_str(chunk))
            .await
            .unwrap();
        assert_eq!(reply.text, expected);
        assert_eq!(streamed, expected);
        assert_eq!(session.current_model(), Some("two"));
        if mode != "copilot" {
            assert_eq!(
                session.prompt(None, "unexpected tool", |_| {}).await,
                Err(Error::Unsafe)
            );
            assert_eq!(
                session.prompt(None, prompt, |_| {}).await,
                Err(Error::Closed)
            );
        }
        let (_root, wrong_version) = fixture(id, "custom");
        assert!(!wrong_version.safe_to_run().await.unwrap());
    }
}

#[tokio::test]
#[ignore = "Requires official CLI releases on PATH and no provider credentials"]
async fn installed_restricted_cli_signed_out_probe() {
    for id in ["githubCopilot", "gemini"] {
        let engine = discover(id).unwrap().expect(id);
        let probe = engine
            .probe()
            .await
            .unwrap_or_else(|error| panic!("{id}: {error:?}"));
        assert!(probe.needs_auth, "{id}");
        assert!(!engine.safe_to_run().await.unwrap(), "{id}");
    }
    let engine = discover("opencodeGo").unwrap().expect("OpenCode");
    let probe = engine.probe().await.unwrap();
    let selected = probe
        .models
        .iter()
        .find(|model| Some(model.id.as_str()) != probe.current_model.as_deref())
        .expect("OpenCode offers an alternative model");
    let mut wire = Wire::launch(&engine).unwrap();
    let open_code = restricted::Restricted::OpenCode;
    open_code
        .verify_agent(&initialize(&mut wire).await.unwrap())
        .unwrap();
    let params = json!({"cwd":wire.cwd(), "mcpServers":[]});
    let session = wire.request("session/new", params).await.unwrap();
    assert!(restricted::Restricted::open_code_mode(&session));
    open_code
        .select_model(
            &mut wire,
            session["sessionId"].as_str().unwrap(),
            &selected.id,
        )
        .await
        .unwrap();
}
