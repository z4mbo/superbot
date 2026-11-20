use super::*;

#[tokio::test]
async fn isolated_installed_cli_lifecycle() {
    let fixture = tempfile::tempdir().unwrap();
    let bin = fixture.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let claude = bin.join(Provider::Claude.executable());
    let codex = bin.join(Provider::Codex.executable());
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("local_cli.rs");
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let built = std::process::Command::new(compiler)
        .arg(source)
        .arg("-o")
        .arg(&claude)
        .status()
        .unwrap();
    assert!(built.success());
    std::fs::copy(&claude, &codex).unwrap();

    let dir = fixture.path().join("scope-a");
    let mut cli = LocalCli {
        dir: dir.clone(),
        executables: [Some(claude), None],
        installed_codex_home: None,
    };
    assert_eq!(cli.status(Provider::Codex).await, Status::Missing);
    assert_eq!(cli.selection("bot-a"), Ok(None));
    cli.executables[Provider::Codex as usize] = Some(codex);

    for (provider, model_id, reply) in [
        (Provider::Claude, "haiku", "Claude fixture reply"),
        (Provider::Codex, "gpt-5.6-terra", "Codex fixture reply"),
    ] {
        let model = InstalledModel {
            provider: provider.id().to_owned(),
            id: model_id.to_owned(),
            label: "Fixture model".into(),
        };
        let prompt = "Write a response to --dangerously-bypass & test ☃";
        assert_eq!(cli.status(provider).await, Status::SignedOut);
        assert_eq!(
            cli.reply(&model, prompt).await,
            Err(Status::SignedOut.label())
        );
        assert_eq!(cli.sign_in(provider).await, Ok(Status::Ready));
        assert_eq!(cli.catalog(provider).await.unwrap(), vec![model.clone()]);
        cli.save_selection("bot-a", Some(&model)).unwrap();
        assert_eq!(cli.selection("bot-b"), Ok(None));
        let reopened = LocalCli {
            dir: dir.clone(),
            executables: cli.executables.clone(),
            installed_codex_home: cli.installed_codex_home.clone(),
        };
        assert_eq!(reopened.selection("bot-a"), Ok(Some(model.clone())));
        assert_eq!(reopened.reply(&model, prompt).await.unwrap(), reply);
        let other_account = LocalCli {
            dir: fixture.path().join("scope-b"),
            executables: cli.executables.clone(),
            installed_codex_home: cli.installed_codex_home.clone(),
        };
        assert_eq!(other_account.selection("bot-a"), Ok(None));
        assert_eq!(other_account.status(provider).await, Status::SignedOut);
        assert_eq!(cli.sign_out(provider).await, Ok(Status::SignedOut));
        assert!(cli.reply(&model, prompt).await.is_err());
    }

    let installed = fixture.path().join("installed-codex");
    std::fs::create_dir(&installed).unwrap();
    let marker = installed.join("fake-signed-in");
    std::fs::write(&marker, "fake credential kept in installed profile").unwrap();
    cli.installed_codex_home = Some(installed.clone());
    let codex = Provider::Codex;
    let model = InstalledModel {
        provider: codex.id().into(),
        id: "gpt-5.6-terra".into(),
        label: "Fixture model".into(),
    };
    let prompt = "Write a response to --dangerously-bypass & test ☃";
    assert_eq!(cli.status(codex).await, Status::SignedOut);
    cli.choose_installed_codex(true).unwrap();
    assert_eq!(cli.clone().uses_installed_codex(), Ok(true));
    let other_scope = LocalCli {
        dir: fixture.path().join("scope-b"),
        ..cli.clone()
    };
    assert_eq!(other_scope.uses_installed_codex(), Ok(false));
    assert_eq!(other_scope.status(codex).await, Status::SignedOut);
    assert_eq!(cli.status(codex).await, Status::Ready);
    assert_eq!(cli.catalog(codex).await.unwrap(), vec![model.clone()]);
    assert_eq!(
        cli.reply(&model, prompt).await.unwrap(),
        "Codex fixture reply"
    );
    assert!(cli.sign_in(codex).await.is_err());
    assert!(cli.sign_out(codex).await.is_err());
    let instructions = installed.join("AGENTS.md");
    std::fs::write(&instructions, "fixture private instructions").unwrap();
    assert_eq!(cli.status(codex).await, Status::InstalledCodexInstructions);
    assert!(cli.reply(&model, prompt).await.is_err());
    std::fs::remove_file(instructions).unwrap();

    cli.choose_installed_codex(false).unwrap();
    assert_eq!(cli.status(codex).await, Status::SignedOut);
    assert_eq!(cli.sign_in(codex).await, Ok(Status::Ready));
    cli.save_selection("bot-a", Some(&model)).unwrap();
    cli.choose_installed_codex(true).unwrap();
    assert_eq!(cli.selection("bot-a"), Ok(Some(model.clone())));
    assert_eq!(cli.status(codex).await, Status::Ready);
    cli.choose_installed_codex(false).unwrap();
    assert_eq!(cli.status(codex).await, Status::Ready);
    assert_eq!(cli.sign_out(codex).await, Ok(Status::SignedOut));
    assert_eq!(std::fs::read_dir(dir.join("codex")).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&installed).unwrap().count(), 1);
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "fake credential kept in installed profile"
    );
    assert_eq!(
        std::fs::read(dir.join("codex-account")).unwrap(),
        b"separate"
    );

    let write = PendingHistory {
        id: "stable-id".into(),
        text: "prompt".into(),
        reply: Some("response".into()),
    };
    cli.stage_history("bot-a", &write).unwrap();
    assert_eq!(cli.pending_history("bot-b"), Ok(None));
    assert_eq!(cli.pending_history("bot-a"), Ok(Some(write.clone())));
    cli.stage_history("bot-a", &write).unwrap();
    let next = PendingHistory {
        id: "new-id".into(),
        ..write.clone()
    };
    assert!(cli.stage_history("bot-a", &next).is_err());
    cli.clear_history("bot-a", &write).unwrap();
    assert_eq!(cli.pending_history("bot-a"), Ok(None));
    cli.stage_history("bot-a", &next).unwrap();
    cli.clear_history("bot-a", &write).unwrap();
    assert_eq!(cli.pending_history("bot-a"), Ok(Some(next)));
    cli.save_selection("bot-a", None).unwrap();
    assert_eq!(cli.selection("bot-a"), Ok(None));
    std::fs::write(dir.join("claude").join("old"), "").unwrap();
    assert_eq!(
        cli.status(Provider::Claude).await,
        Status::UnsupportedVersion
    );
    assert_eq!(
        cli.run(
            Provider::Codex,
            &["timeout"],
            None,
            Duration::from_millis(150)
        )
        .await
        .err(),
        Some("The local CLI timed out."),
    );
}
