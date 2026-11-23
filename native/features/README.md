# Superbot feature services

Depend on `superbot-features` and pass the signed-in `superbot_client::Client` from your existing session flow to `Features::new(client)`. Use one `Features` per session and bind each operation to its intended Space.

```rust
use superbot_client::Client;
use superbot_features::{Error, Features, MessagePageOptions, ThreadPage, ThreadTarget};

async fn group_history(client: Client, space_id: &str, group_id: &str)
    -> Result<ThreadPage, Error>
{
    let features = Features::new(client);
    features.space(space_id)
        .thread_messages(ThreadTarget::Group(group_id), &MessagePageOptions::default())
        .await
}
```

| Workflow                   | Entry points                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bots and agent settings    | `list_bots`, `list_archived_bots`, `bot`, `create_bot`, `duplicate_bot`, `update_bot`, `set_bot_computer`, `archive_bot`, `restore_bot`                                                                                                                                           |
| Model connections          | `model_catalog`, `model_connections`, `main_model`, `probe_server_models`, `probe_provider_models`, `connect_model`, `set_main_model`, `disconnect_model`. `model_providers` groups the catalog into provider descriptors and `model_options` lists what the connections can run. |
| Groups                     | `list_groups`, `list_archived_groups`, `group`, `create_group`, `duplicate_group`, `update_group`, `archive_group`, `restore_group`, `remove_group`                                                                                                                               |
| Thread history and actions | `thread_head`, `thread`, `thread_messages`, `send`, `stop_thread`, `clear_thread`, `mark_read`, `mark_unread`, `snooze_thread`                                                                                                                                                    |
| Files                      | `list_bot_artifacts`, `list_artifacts`, `artifact_versions`, `upload_artifact`, `artifact`, `artifact_by_id`, `remove_artifact`                                                                                                                                                   |
| Routines and activity      | `list_routines`, `create_routine`, `update_routine`, `routine_history`, `test_routine`, `remove_routine`, `list_runs`                                                                                                                                                             |
| Approvals                  | `answer_thread_card`, `approval_rules`, `set_approval_rule`, `remove_approval_rule`, `auto_review`, `set_auto_review`, `setting_overrides`, `set_setting_override`                                                                                                                |
| Space membership           | `members`, `add_member`, `remove_member`, `leave`, `create_invite`, `cancel_invites` on the bound Space. Use `Features::preview_space_invite` and `Features::accept_space_invite` with a token before binding the joined Space.                                                   |

- Calls share the client's authentication and `Error`. Workspace permissions and validation come from Superbot. Use `Error::is_unauthorized()` to detect a rejected session.
- `None` omits an ordinary optional input. For nullable edits, `Patch::Unchanged` omits the field and `Patch::Clear` sends JSON null. Use `ModelSelection::set` or `ModelSelection::clear` for paired model fields. For edits based on previously shown content, pass `expected_instructions` or `expected_bot_ids` when applicable so the server can reject a stale write.
- A thread target is a bot ID or group ID. Read older pages by passing `older_cursor` as `before`. Thread message blocks preserve wire JSON for cards and attachments. When answering an approval, use the action ID shown on the pending card with its message ID and run ID. The server determines the action's effect.
- Uploads and downloads carry base64 in memory. Reuse the same caller-generated nonce and payload when retrying an ambiguous send, upload, or routine test run. Other mutations may have side effects if repeated.
- The client crate provides the existing one-to-one chat stream. This crate performs explicit reads and mutations and leaves refresh triggers to the caller.

Run `cargo test -p superbot-features` from the workspace root for the authenticated loopback RPC fixtures. See [the parity inventory](../../docs/superbot/parity.md) for retained paths and coverage.
