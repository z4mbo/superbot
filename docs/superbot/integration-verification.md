# Superbot integration verification

The isolated fixture served web and auth at `http://127.0.0.1:5360` and RPC at `http://127.0.0.1:5361`, backed by private PostgreSQL and the email emulator. Three verified synthetic accounts used the fixture's `bootstrap-owner` command. The invite email went to the emulator.

| Path                               | Result                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-account Space membership     | Passed. The guest was denied before joining, could preview and accept an invite, and could select the shared Space. The owner could manage members. The guest could list members and received HTTP 403 when creating an invite. Removal revoked membership and a fresh invite restored it.                          |
| Space invites                      | Passed. The API reported that the emulator accepted the invite email. Cancellation invalidated a link, and another account received HTTP 404 when replaying a used link.                                                                                                                                            |
| Registry submission and visibility | Passed. Anonymous discovery returned HTTP 401. A submission entered pending status and appeared only in the publisher's own submissions. Pending versions stayed out of discovery and could not be installed. Another publisher could not claim the slug, and the publisher's own review attempt returned HTTP 403. |
| Registry review and installation   | Passed. A verified reviewer listed in the fixture API's `RAKAZO_ADMIN_EMAILS` approved the first version and rejected the next one. The guest discovered the approved version and installed it twice with the same installation ID and zero initial grants.                                                         |
| Per-agent access and removal       | Passed. Two agents received independent grants. The server rejected an unknown capability, another account's agent and changes by another account. Removing one grant preserved the other. Uninstall removed the installation, and reinstall started with zero grants.                                              |

## Web and plugin runtime

| Flow                                | Verification                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin authoring and review         | A synthetic publisher submitted a skill. A different verified reviewer approved it. The hosted store displayed the approved release and allowed installation and grants to an individual bot.                                                      |
| Registry search and version changes | Restricted-role PostgreSQL tests exercised filtering before cursor pagination and actor-scoped version switching. A successful switch clears previous grants. Concurrent updates, stale pins and rejected releases preserve transaction integrity. |
| Remote plugin execution             | The executor ran the sample converter through its MCP interface and returned 212 °F for 100 °C. It sent no call on denial or stale approval. The fixture used isolated test transport. See the [runtime reference](plugin-runtime.md).             |

The [marketplace chat fixture](chat-verification.md#marketplace-skill-through-the-cli) checks a marketplace skill through the complete registry and worker path and a CLI conversation. All 33 product authorization and resource-isolation tests passed against fresh PostgreSQL, including the test that rejects anonymous calls to all ten registry methods.

## Rerun

Launch the isolated Superbot fixture with private PostgreSQL and fake email on the ports above. Configure its API process to allowlist a dedicated synthetic reviewer through `RAKAZO_ADMIN_EMAILS`. Use `bootstrap-owner` against the same fixture database to provision three distinct `@example.test` accounts. Set `SMOKE_OWNER`, `SMOKE_GUEST`, and `SMOKE_REVIEWER` to their email addresses and set `SMOKE_PASSWORD` to the password they share for that run. Keep credentials in the invoking shell.

```powershell
node docs/superbot/integration-smoke.mjs
```

The smoke test creates a fresh Space and registry slug per run and revokes its HTTP sessions before exit. Use disposable fixture data because registry submissions persist and an interrupted run can leave its test Space behind. The registry manifest contains only a synthetic skill, so review requires no external MCP service.
