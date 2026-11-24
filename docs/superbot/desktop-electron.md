# Superbot Electron desktop app

The Electron app in `apps/desktop` ships as **Superbot** (`Superbot.app`, `Superbot-Setup-<version>.exe`, the `superbot` AppImage). It was called Rakazo before.

## Existing installs

Electron keeps its profile in a folder named after the app, so the renamed app looks in `Superbot` instead of `Rakazo` (`~/Library/Application Support`, `%APPDATA%`, `~/.config`). On its first launch, before anything reads that folder, the app copies the old `Rakazo` folder into the new one and writes `.migrated-from-rakazo` there. It never changes or removes the old folder, skips caches and the old process's lock files, and does nothing once the new folder holds a profile of its own. If the copy fails, the partial copy is removed and the app starts on a fresh profile.

Encrypted values do not carry over on macOS and Linux: the system key that protects them is stored under the app's name. The desktop pairs this computer again and the server asks you to sign in once. On Windows the key moves with the profile.

## Settings

Every `RAKAZO_*` variable the desktop app reads also works as `SUPERBOT_*`, and the `SUPERBOT_` name wins when both are set.

| Variable | Default | Effect |
| --- | --- | --- |
| `SUPERBOT_SERVER_URL` | none | The server setup offers, and opens on a first launch. Unset, a first launch opens setup. |
| `SUPERBOT_IMAGE_REGISTRY` | `ghcr.io/z4mbo/superbot` | Where a new local stack pulls `app` and `computer` from. A stack that already exists keeps the images its `.env` names. |
| `SUPERBOT_PASSKEY_RP_ID` | none | The passkey domain a macOS build is associated with, at build time. Unset, the build has no system passkeys. |

The `x-rakazo-space-id` request header keeps its old name so servers and clients from before and after the rename work together.
