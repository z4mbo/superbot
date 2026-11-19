# Superbot native client

`superbot_client::Client` is cloneable. Its async methods run on Tokio.
`Client::new(&str)` accepts an HTTPS origin or local HTTP origin. `DEFAULT_SERVER`
is the local Superbot hosting origin, `http://127.0.0.1:5173`.

| Method                                                                           | Result                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `client.with_token(token)`                                                       | A client with a signed Rakazo bearer                                                                 |
| `client.sign_up(name, email, password).await`                                    | `SignUpResult::SignedIn(Client)` or `SignUpResult::VerifyEmail` according to server admission policy |
| `client.sign_in(email, password).await`                                          | An authenticated client                                                                              |
| `client.request_sign_in_code(email).await`                                       | Requests an email code                                                                               |
| `client.sign_in_with_code(email, code).await`                                    | An authenticated client                                                                              |
| `client.sign_out().await`                                                        | Revokes the session                                                                                  |
| `CredentialStore::load(&client).await`                                           | `Option<Client>` from OS credential storage                                                          |
| `CredentialStore::save(&client).await`                                           | Saves the signed session for this server                                                             |
| `CredentialStore::delete(&client).await`                                         | Removes the saved session for this server                                                            |
| `client.list_spaces().await`                                                     | `Vec<Space>` with `id` and `name`                                                                    |
| `client.list_agents(space_id).await`                                             | `Vec<Agent>` with `id` and `name`                                                                    |
| `client.thread(space_id, agent_id).await`                                        | `ThreadSnapshot` with `thread_id`, `cursor`, and `messages`                                          |
| `client.messages(space_id, agent_id).await`                                      | Recent `Vec<Message>` with `id`, `role`, `text`, `seq`, and `run_id`                                 |
| `client.send_message(space_id, agent_id, text).await`                            | `SendReceipt` with `task_id`, `run_id`, `seq`, and `run_ids`                                         |
| `client.send_with_nonce(space_id, agent_id, text, nonce).await`                  | Same send with caller-supplied idempotency key                                                       |
| `client.subscribe(space_id, agent_id, cursor).await`                             | `EventStream` with `Result<ThreadEvent, Error>` items                                                |
| `client.subscribe_thread(space_id, ThreadTarget::Group(group_id), cursor).await` | The same resumable event stream for a shared group conversation                                      |
| `client.subscribe_notifications(space_id).await`                                 | Signed stream of roster, organization and run change hints                                           |
| `client.rpc::<T>(path, space_id, input).await`                                   | Authenticated oRPC procedure result deserialized into `T`                                            |

Method results are wrapped in `Result<_, Error>`. `Error::is_unauthorized()`
identifies an expired or rejected session. The RPC input is a
`serde_json::Value`, the optional Space ID maps to `x-rakazo-space-id`, and
procedure paths are relative to `/rpc/` (for example `pluginRegistry/discover`).

Use `thread` to load the latest history and its cursor together. Consume the
stream with `StreamExt::next`. `ThreadEvent` exposes `id`, `seq`, `run_id`,
`kind`, and `data` (the payload). `ThreadEvent::message()` converts
message creation and update events to `Message`. Save the last processed
non-heartbeat sequence to resume the stream. Match replies and terminal run
events by `run_id`. The send receipt's `seq` is the user's message sequence.

History and live messages both expose the optional human `author` (ID and display name) and optional `bot_id`. Older messages may lack author information.

The notifications stream sends catch-up hints on every connection and has no cursor. Read current data through the corresponding scoped RPC after a hint. The Rust method discards chat alerts, heartbeats and unrelated change kinds.
