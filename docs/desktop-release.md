# Desktop releases

The `release-desktop` workflow builds, signs, notarizes, attests, and publishes
the Superbot desktop app from a `vMAJOR.MINOR.PATCH` tag on `main`. The same
tag publishes the server images through `publish-server-image`.

Each release carries:

| Platform | Installer                       | Updates                                                                                                                                                     |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Universal `.dmg` (and `.zip`)   | Installs itself from the `.zip` (`latest-mac.yml`)                                                                                                          |
| Windows  | x64 NSIS `Superbot-Setup-*.exe` | Installs itself (`latest.yml`), only from the same signing publisher                                                                                        |
| Linux    | x64 `.AppImage` and `.deb`      | The AppImage installs itself (`latest-linux.yml` plus its `.sig`); a deb install shows the update and its notes, then opens the release page to download it |

The deb is not updated in place: that would need root through a system prompt
and an unsigned local package install. It reads the same feed, so its users see
the same "Update available" prompt and release notes as everyone else.

## Credentials

Names only; set values with `gh secret set` / `gh variable set` and never commit
them. Every build job runs in the `desktop-release` environment.

| Name                               | Kind        | Platform | Required | Purpose                                                                                                             |
| ---------------------------------- | ----------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP_MAC_CSC_LINK`             | Secret      | macOS    | Yes      | Base64 of the `Developer ID Application` certificate and key exported as `.p12`                                     |
| `DESKTOP_MAC_CSC_KEY_PASSWORD`     | Secret      | macOS    | Yes      | Password used when exporting the `.p12`                                                                             |
| `APPLE_API_KEY_ID`                 | Secret      | macOS    | Yes      | App Store Connect API key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`), for notarization                        |
| `APPLE_API_ISSUER`                 | Secret      | macOS    | Yes      | Issuer ID shown on App Store Connect > Users and Access > Integrations                                              |
| `APPLE_API_KEY_P8`                 | Secret      | macOS    | Yes      | Contents of the `AuthKey_*.p8` file                                                                                 |
| `DESKTOP_MAC_PROVISIONING_PROFILE` | Secret      | macOS    | No       | Base64 provisioning profile with Associated Domains; without it macOS builds hide passkeys                          |
| `DESKTOP_WIN_AZURE_CLIENT_ID`      | Secret      | Windows  | Yes      | Application (client) ID of the Azure app registration that signs                                                    |
| `DESKTOP_WIN_AZURE_TENANT_ID`      | Secret      | Windows  | Yes      | Directory (tenant) ID of that app registration                                                                      |
| `DESKTOP_WIN_SIGNING_ENDPOINT`     | Variable    | Windows  | Yes      | The Artifact Signing account's URI, such as `https://eus.codesigning.azure.net/`                                    |
| `DESKTOP_WIN_SIGNING_ACCOUNT`      | Variable    | Windows  | Yes      | The signing account name                                                                                            |
| `DESKTOP_WIN_SIGNING_PROFILE`      | Variable    | Windows  | Yes      | The certificate profile name                                                                                        |
| `DESKTOP_WIN_PUBLISHER`            | Variable    | Windows  | Yes      | The certificate's common name, exactly as validated; updates must match it                                          |
| `desktop-release`                  | Environment | Windows  | Yes      | The OIDC subject Azure trusts; GitHub creates it on first use if it does not exist                                  |
| `DESKTOP_LINUX_UPDATE_SIGNING_KEY` | Secret      | Linux    | Yes      | Ed25519 private key (PEM) whose public half is `LINUX_UPDATE_PUBLIC_KEY` in the app                                 |
| `DESKTOP_RELEASE_MAC_ONLY`         | Variable    | All      | No       | `true` builds only macOS (see [fork distribution](fork-desktop-distribution.md)); unset or `false` builds all three |
| `GITHUB_TOKEN`                     | Automatic   | All      | Yes      | Provided by Actions; the publish job holds `contents: write`, `attestations: write` and `id-token: write`           |

The same tag publishes the CLI to npm as `superbot-cli` through
`release-cli`; its credential (the `NPM_TOKEN` secret for the first release,
then npm trusted publishing) is covered in [CLI releases](cli-release.md).

### Without credentials

Nothing is published and no release is created. Every platform fails closed:
macOS stops at "Require macOS signing and notarization credentials", Windows at
"Require Windows signing credentials", and Linux at "Sign Linux AppImage
updates" after building. The publish job needs every selected platform to
succeed, so a missing credential on any of them stops the whole release. There
is no unsigned fallback. Setting `DESKTOP_RELEASE_MAC_ONLY` to `true` skips
Windows and Linux, but macOS still needs its signing and notarization secrets.

### macOS

The API key needs the Developer role. The workflow writes it to a mode 600 file
in the runner's temp directory for the packaging step and deletes it afterwards.

```sh
base64 -i devid.p12 | gh secret set DESKTOP_MAC_CSC_LINK
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

### Windows

Windows signs through Azure Artifact Signing, logging in with GitHub OIDC
instead of a stored secret. Create a Public Trust certificate profile, then an
app registration with the Artifact Signing Certificate Profile Signer role on
the signing account, and a `desktop-release` environment in the repository
settings. Give the app registration a federated credential whose subject is
exactly the one printed under "Federated token details" in the release's Azure
login step. GitHub's OIDC subject can include owner and repository IDs, so the
plain `repo:<owner>/<repo>:environment:desktop-release` form may not match.

The installer and app must carry a valid, timestamped Authenticode signature
from `DESKTOP_WIN_PUBLISHER`, and the packaged update config only accepts
updates signed by that same publisher.

### Linux

The AppImage verifies each downloaded update against an Ed25519 public key
compiled into the app (`LINUX_UPDATE_PUBLIC_KEY` in
`apps/desktop/src/main/updates/linux-update-signature.ts`) before installing
it. The key there today is the one this codebase was imported with, so a
Superbot release needs its own pair: generate one, commit the public half in
place of that constant, and store the private half as the secret.

```sh
openssl genpkey -algorithm ed25519 -out linux-update.pem
openssl pkey -in linux-update.pem -pubout          # paste into LINUX_UPDATE_PUBLIC_KEY
gh secret set DESKTOP_LINUX_UPDATE_SIGNING_KEY < linux-update.pem
```

Keep the private key offline afterwards; installed AppImages only accept
updates it signed. The deb needs no update key: it is never installed by the
app, and its checksum is in the release's `SHA256SUMS` and provenance
attestation like every other asset.

## Cut a release

Follow `.agents/skills/release/SKILL.md`: one release PR writes the
`CHANGELOG.md` section from the pull requests merged since the last tag and
bumps `version` in `apps/desktop/package.json`. Once it merges, tag the merge
commit `v<version>` and push the tag.

The workflow refuses tags that do not match the desktop version, have no
matching changelog section, are not on `main`, or are not newer than the latest
published release. It uploads everything to a draft first and publishes it as
the latest release only once every platform's installer and update feed are in
place. The release text is that changelog section followed by GitHub's list of
merged pull requests; the app shows the same text as the update's release
notes.

## Apple silicon server bundle

The macOS job also builds `rakazo-server-darwin-arm64-<version>.tar.xz` with
`scripts/build-server-bundle.mjs` and publishes it as an asset of the same
release. It holds the API, worker, web server and migrations with their
production dependencies, so This computer can run them without Docker. The app
does not include it; it ships only `server-bundle.json` in its resources, with
the asset's `url`, `sha256`, `size` and `version`, and downloads the bundle when
someone picks This computer. Builds without that file, such as local packaging,
have no bundle to download.
