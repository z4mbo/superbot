use serde_json::{Value, json};
use superbot_client::Client;
use superbot_features::{
    ApprovalEffect, ApprovalMatch, BotSettings, Features, MessageAnchor, MessagePageOptions,
    ModelSelection, Patch, RoutineUpdate, SendMessage, SettingsScope, ThreadTarget, UploadArtifact,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

async fn fixture(
    path: &'static str,
    scope: Option<&'static str>,
    input: Value,
    status: &'static str,
    response: Value,
) -> (Features, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let client = Client::new(&origin)
        .unwrap()
        .with_token("fixture.signature")
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(stream.read_u8().await.unwrap());
        }
        let headers = String::from_utf8(headers).unwrap();
        let mut lines = headers.lines();
        assert_eq!(lines.next().unwrap(), format!("POST /rpc/{path} HTTP/1.1"));
        let headers: std::collections::HashMap<_, _> = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(key, value)| (key.to_ascii_lowercase(), value))
            .collect();
        assert_eq!(headers["authorization"], "Bearer fixture.signature");
        assert_eq!(headers.get("x-rakazo-space-id").copied(), scope);
        let mut body = vec![0; headers["content-length"].parse().unwrap()];
        stream.read_exact(&mut body).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"json": input})
        );
        let body = json!({"json": response}).to_string();
        stream.write_all(format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ).as_bytes()).await.unwrap();
    });
    (Features::new(client), server)
}

const SPACE: Option<&str> = Some("team");

#[tokio::test]
async fn conversation_update_keeps_false_fields_and_reads_shared_metadata() {
    let (features, server) = fixture(
        "threads/updateBotConversation",
        SPACE,
        json!({ "botId": "bot", "threadId": "thread", "archived": false, "pinned": false }),
        "200 OK",
        json!({
            "botId": "bot", "threadId": "thread", "createdAt": "2026-01-01T00:00:00Z",
            "title": "Recovered thread", "pinnedAt": null, "archivedAt": null, "preview": "Hello"
        }),
    )
    .await;
    let row = features
        .space("team")
        .update_bot_conversation(
            "bot",
            "thread",
            superbot_features::BotConversationPatch {
                archived: Some(false),
                pinned: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(row.thread_id, "thread");
    assert_eq!(row.title.as_deref(), Some("Recovered thread"));
    assert_eq!(row.preview.as_deref(), Some("Hello"));
    assert_eq!(row.pinned_at, None);
    assert_eq!(row.archived_at, None);
    server.await.unwrap();
}

#[tokio::test]
async fn conversation_list_accepts_servers_without_metadata() {
    let (features, server) = fixture(
        "threads/listBotConversations",
        SPACE,
        json!({ "botId": "bot" }),
        "200 OK",
        json!([{ "botId": "bot", "threadId": "thread", "createdAt": "2026-01-01T00:00:00Z" }]),
    )
    .await;
    let rows = features
        .space("team")
        .bot_conversations("bot")
        .await
        .unwrap();
    assert_eq!(rows[0].thread_id, "thread");
    assert_eq!(rows[0].title, None);
    assert_eq!(rows[0].preview, None);
    server.await.unwrap();
}

#[tokio::test]
async fn group_send_accepts_attachment_only_and_preserves_nonce() {
    let (features, server) = fixture(
        "threads/send",
        SPACE,
        json!({"groupId": "group", "artifactIds": ["file"], "clientNonce": "send-once"}),
        "200 OK",
        json!({"taskId": "task", "runId": "run", "seq": 2, "runIds": ["run", "peer"]}),
    )
    .await;
    let result = features
        .space("team")
        .send(
            ThreadTarget::Group("group"),
            &SendMessage {
                artifact_ids: &["file"],
                client_nonce: Some("send-once"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.run_ids, ["run", "peer"]);
    server.await.unwrap();
}

#[tokio::test]
async fn thread_page_preserves_approval_blocks_and_opaque_context() {
    let ask = json!({"kind": "ask", "question": "Continue?", "actions": [{"id": "allow", "label": "Allow once"}]});
    let (features, server) = fixture(
        "threads/messages",
        SPACE,
        json!({"botId": "bot", "around": {"messageId": "message"}, "includePeerRuns": false}),
        "200 OK",
        json!({"threadId": "thread", "olderCursor": 1, "messages": [{
            "id": "message", "threadId": "thread", "seq": 2, "role": "bot",
            "runId": "run", "createdAt": "2026-01-01T00:00:00Z", "blocks": [ask]
        }]}),
    )
    .await;
    let result = features
        .space("team")
        .thread_messages(
            ThreadTarget::Bot("bot"),
            &MessagePageOptions {
                around: Some(MessageAnchor::Message("message")),
                include_peer_runs: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.messages[0].blocks, [ask]);
    assert_eq!(result.older_cursor, Some(1));
    server.await.unwrap();
}

#[tokio::test]
async fn upload_is_a_scoped_artifact_rpc() {
    let (features, server) = fixture(
        "artifacts/create", SPACE,
        json!({"groupId": "group", "name": "notes.txt", "mimeType": "text/plain", "contentBase64": "aGk=", "clientNonce": "upload-once"}),
        "200 OK", json!({"id": "file", "groupId": "group", "botId": null, "runId": null,
            "name": "notes.txt", "description": null, "size": 2, "version": 1,
            "mimeType": "text/plain", "createdAt": "2026-01-01T00:00:00Z"}),
    ).await;
    let file = features
        .space("team")
        .upload_artifact(
            ThreadTarget::Group("group"),
            &UploadArtifact {
                name: "notes.txt",
                mime_type: "text/plain",
                content_base64: "aGk=",
                description: None,
                client_nonce: Some("upload-once"),
            },
        )
        .await
        .unwrap();
    assert_eq!(file.id, "file");
    server.await.unwrap();
}

#[tokio::test]
async fn bot_settings_clear_model_as_a_pair_and_keep_server_conflict() {
    let (features, server) = fixture(
        "bots/update",
        SPACE,
        json!({"botId": "bot", "modelProvider": null, "modelId": null, "voiceId": null,
            "notifyOnFinish": false, "instructions": "new", "expectedInstructions": "old"}),
        "409 Conflict",
        json!({"code": "CONFLICT", "status": 409, "message": "Instructions changed"}),
    )
    .await;
    let error = features
        .space("team")
        .update_bot(
            "bot",
            &BotSettings {
                instructions: Some("new"),
                expected_instructions: Some("old"),
                model: Some(ModelSelection::clear()),
                voice_id: Patch::Clear,
                notify_on_finish: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        superbot_features::Error::Server { status: 409, .. }
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn group_archive_uses_group_id() {
    let (features, server) = fixture(
        "groups/archive",
        SPACE,
        json!({"groupId": "group"}),
        "200 OK",
        json!({"ok": true}),
    )
    .await;
    features.space("team").archive_group("group").await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn routine_patch_clears_nullable_trigger_and_preserves_false() {
    let (features, server) = fixture(
        "routines/update",
        SPACE,
        json!({"routineId": "routine", "emailSenders": null, "active": false}),
        "200 OK",
        json!({"id": "routine", "botId": "bot", "name": "Check", "prompt": "Check notes",
            "crons": ["0 8 * * *"], "timezone": "UTC", "active": false, "notify": true,
            "webhookEnabled": false, "githubEnabled": false, "createdAt": "2026-01-01T00:00:00Z"}),
    )
    .await;
    let result = features
        .space("team")
        .update_routine(
            "routine",
            &RoutineUpdate {
                email_senders: Patch::Clear,
                active: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!result.active);
    server.await.unwrap();
}

#[tokio::test]
async fn sends_card_action_instead_of_a_synthetic_approval_route() {
    let (features, server) = fixture(
        "threads/answer",
        SPACE,
        json!({"groupId": "group", "runId": "run", "messageId": "message", "answer": "allow"}),
        "200 OK",
        json!({"ok": true}),
    )
    .await;
    features
        .space("team")
        .answer_thread_card(ThreadTarget::Group("group"), "run", "message", "allow")
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn approval_rules_bind_settings_scope_separately_from_space() {
    let (features, server) = fixture(
        "approvalRules/set", SPACE,
        json!({"scope": "account", "effect": "require_approval", "matchKind": "site", "matchValue": "example.test"}),
        "200 OK", json!({"id": "rule", "effect": "require_approval", "matchKind": "site",
            "matchValue": "example.test", "createdAt": "2026-01-01T00:00:00Z"}),
    ).await;
    let rule = features
        .space("team")
        .set_approval_rule(
            Some(SettingsScope::Account),
            ApprovalEffect::RequireApproval,
            ApprovalMatch::Site("example.test"),
        )
        .await
        .unwrap();
    assert_eq!(rule.id, "rule");
    server.await.unwrap();
}

#[tokio::test]
async fn invite_preview_does_not_bind_space_before_membership() {
    let (features, server) = fixture("spaces/invites/preview", None, json!({"token": "invite"}),
        "200 OK", json!({"spaceId": "team", "spaceName": "Team", "inviterName": "Pat", "alreadyMember": false})).await;
    assert_eq!(
        features
            .preview_space_invite("invite")
            .await
            .unwrap()
            .space_id,
        "team"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn invite_creation_uses_named_space_and_omits_email_for_shareable_links() {
    let (features, server) = fixture(
        "spaces/invites/create",
        SPACE,
        json!({"spaceId": "team"}),
        "200 OK",
        json!({"url": "https://example.test/invite/token", "expiresAt": "2026-01-02T00:00:00Z"}),
    )
    .await;
    assert!(
        features
            .space("team")
            .create_invite(None)
            .await
            .unwrap()
            .emailed
            .is_none()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn runs_filter_decodes_activity_envelope() {
    let (features, server) = fixture(
        "runs/list",
        SPACE,
        json!({"filter": "active"}),
        "200 OK",
        json!({"runs": []}),
    )
    .await;
    assert!(
        features
            .space("team")
            .list_runs(superbot_features::RunFilter::Active)
            .await
            .unwrap()
            .is_empty()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn artifact_download_decodes_flattened_metadata_and_content() {
    let (features, server) = fixture(
        "artifacts/getById",
        SPACE,
        json!({"artifactId": "file"}),
        "200 OK",
        json!({"id": "file", "groupId": null, "botId": "bot", "runId": null,
            "name": "notes.txt", "description": null, "size": 2, "version": 1,
            "mimeType": "text/plain", "createdAt": "2026-01-01T00:00:00Z", "contentBase64": "aGk="}),
    ).await;
    let result = features.space("team").artifact_by_id("file").await.unwrap();
    assert_eq!(result.artifact.bot_id.as_deref(), Some("bot"));
    assert_eq!(result.content_base64, "aGk=");
    server.await.unwrap();
}

#[tokio::test]
async fn space_members_decodes_role_and_management_metadata() {
    let (features, server) = fixture(
        "spaces/members/list",
        SPACE,
        json!({"spaceId": "team"}),
        "200 OK",
        json!({"spaceName": "Team", "canManage": true, "openInvites": 2, "members": [
            {"userId": "owner", "name": "Pat", "email": "pat@example.test", "image": null, "role": "owner"},
            {"userId": "guest", "name": "Sam", "email": "sam@example.test", "image": null, "role": "member", "guest": true}
        ]}),
    ).await;
    let result = features.space("team").members().await.unwrap();
    assert!(result.can_manage);
    assert_eq!(result.open_invites, Some(2));
    assert!(matches!(
        result.members[0].role,
        superbot_features::SpaceRole::Owner
    ));
    assert_eq!(result.members[1].person.user_id, "guest");
    assert_eq!(result.members[1].guest, Some(true));
    server.await.unwrap();
}

#[tokio::test]
async fn rejected_session_keeps_client_error_classification() {
    let (features, server) = fixture(
        "groups/list",
        SPACE,
        json!({}),
        "401 Unauthorized",
        json!({"code": "UNAUTHORIZED", "status": 401, "message": "Session expired"}),
    )
    .await;
    assert!(
        features
            .space("team")
            .list_groups()
            .await
            .unwrap_err()
            .is_unauthorized()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn a_server_connection_is_new_scoped_and_carries_its_models() {
    let (features, server) = fixture(
        "models/connect",
        SPACE,
        json!({
            "provider": superbot_features::COMPATIBLE_PROVIDER,
            "apiKey": "fixture-key",
            "baseUrl": "http://127.0.0.1:9/v1",
            "apiProtocol": "chat-completions",
            "modelId": "local-a",
            "label": "Local",
            "credentialId": null,
            "enabledModelIds": ["local-b"],
            "makeDefault": true,
        }),
        "200 OK",
        json!({"id": "connection", "provider": "openai-compatible", "label": "Local",
            "hasKey": true, "isDefault": true, "modelId": "local-a",
            "baseUrl": "http://127.0.0.1:9/v1", "authKind": "openai_compatible"}),
    )
    .await;
    let saved = features
        .space("team")
        .connect_model(&superbot_features::ConnectModel {
            provider: superbot_features::COMPATIBLE_PROVIDER,
            api_key: Some("fixture-key"),
            base_url: Some("http://127.0.0.1:9/v1"),
            api_protocol: Some(superbot_features::ApiProtocol::ChatCompletions),
            model_id: Some("local-a"),
            label: Some("Local"),
            credential_id: Patch::Clear,
            enabled_model_ids: Some(&["local-b"]),
            make_default: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(saved.has_key);
    assert_eq!(
        saved.auth_kind,
        Some(superbot_features::ConnectionAuth::OpenaiCompatible)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn the_main_model_is_set_on_the_connection_it_came_from() {
    let (features, server) = fixture(
        "models/setRole",
        SPACE,
        json!({"role": "main", "primary": {"provider": "keyed", "modelId": "k-1", "credentialId": "connection"}}),
        "200 OK",
        json!({"primary": {"provider": "keyed", "modelId": "k-1", "credentialId": "connection"},
            "backups": [], "deploymentPrimary": null}),
    )
    .await;
    let main = features
        .space("team")
        .set_main_model(&superbot_features::ModelOption {
            provider: "keyed".into(),
            model_id: "k-1".into(),
            label: "K 1".into(),
            source: "Keyed".into(),
            credential_id: Some("connection".into()),
        })
        .await
        .unwrap();
    assert_eq!(
        main.running().unwrap().credential_id.as_deref(),
        Some("connection")
    );
    server.await.unwrap();
}

#[tokio::test]
async fn a_server_probe_reports_the_models_it_lists() {
    let (features, server) = fixture(
        "models/probeOpenAiCompatible",
        SPACE,
        json!({"baseUrl": "http://127.0.0.1:9/v1", "apiProtocol": "responses"}),
        "200 OK",
        json!({"models": ["local-a", "local-b"]}),
    )
    .await;
    let models = features
        .space("team")
        .probe_server_models(&superbot_features::ProbeServer {
            base_url: "http://127.0.0.1:9/v1",
            api_protocol: Some(superbot_features::ApiProtocol::Responses),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(models, ["local-a", "local-b"]);
    server.await.unwrap();
}

#[tokio::test]
async fn inbox_targets_round_trip_into_conversation_library_requests() {
    use superbot_features::{InboxKind, InboxState, LibraryKind};

    let (features, server) = fixture(
        "inbox/list",
        SPACE,
        json!({"includeDone": true}),
        "200 OK",
        json!([{
            "id": "question:run", "kind": "question", "state": "unread",
            "target": {"kind": "botConversation", "botId": "bot", "threadId": "thread"},
            "messageId": "ask", "runId": "run", "botId": "bot",
            "title": "Fixture bot", "updatedAt": "2026-01-01T00:00:00Z"
        }]),
    )
    .await;
    let items = features.space("team").inbox(true).await.unwrap();
    let item = &items[0];
    assert_eq!(item.kind, InboxKind::Question);
    assert_eq!(item.state, InboxState::Unread);
    assert_eq!(item.message_id.as_deref(), Some("ask"));
    server.await.unwrap();

    let (features, server) = fixture(
        "conversationLibrary/list",
        SPACE,
        json!({"botId": "bot", "threadId": "thread"}),
        "200 OK",
        json!([{
            "id": "file", "kind": "artifact", "title": "notes.txt", "messageId": "message",
            "authorUserId": "member", "authorBotId": null, "mimeType": "text/plain",
            "createdAt": "2026-01-01T00:00:00Z"
        }]),
    )
    .await;
    let items = features
        .space("team")
        .conversation_library(item.target.as_target())
        .await
        .unwrap();
    assert_eq!(items[0].kind, LibraryKind::Artifact);
    assert_eq!(items[0].author_user_id.as_deref(), Some("member"));
    server.await.unwrap();

    let (features, server) = fixture(
        "inbox/setState",
        SPACE,
        json!({"id": item.id, "state": "done"}),
        "200 OK",
        json!({"ok": true}),
    )
    .await;
    features
        .space("team")
        .set_inbox_state(&item.id, InboxState::Done)
        .await
        .unwrap();
    server.await.unwrap();
}
