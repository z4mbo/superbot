# Releasing the command-line tool

The `superbot` command is published to npm as [`superbot-cli`](https://www.npmjs.com/package/superbot-cli)
by the `release-cli` workflow (`.github/workflows/release-cli.yml`), from the same
`vMAJOR.MINOR.PATCH` tag that releases the desktop app and the server images (see
[Desktop releases](desktop-release.md)). Nothing has been published yet.

## How it is kept from going live by accident

- `apps/cli/package.json` is `"private": true` and stays that way. It names workspace packages
  (`workspace:*`) that npm cannot install, so it is never what gets published.
- `node apps/cli/release/npm-package.mjs stage <folder>` (or `pnpm --filter superbot-cli pack:npm`,
  which also verifies) builds the bundle and writes the folder npm publishes, with a manifest
  generated from `apps/cli/package.json`: no `private`, no scripts, no dev tooling, and only the
  modules the bundle keeps external (the native credential store binding) as dependencies. The
  workspace packages are inside the bundle.
- `verify` packs that folder as a dry run and fails unless the tarball holds exactly `LICENSE`,
  `README.md`, `bin/superbot.js`, `dist/superbot.js` and `package.json`, the manifest names no
  workspace package, and `publishConfig` asks for public access with provenance.
- The workflow publishes only from a release tag `v<version>` that matches the CLI version and
  points at a commit on `main`, after the typecheck, tests, packing, a test install of the
  tarball, and the version check have passed. A manual run is a dry run that keeps the tarball as
  an artifact, unless it is started from such a tag with **publish** ticked.
- Until the package exists on npm, a tag run without the `NPM_TOKEN` secret checks everything and
  then skips publishing with a notice, so releases go on as before.

What makes it live is the first release tag pushed after the `NPM_TOKEN` secret exists, or a
manual run from an existing release tag with **publish** ticked.

## Versions

The CLI has the app's version: `apps/cli/package.json` and `apps/desktop/package.json` always
hold the same one (a test fails otherwise), the release pull request raises both, and the tag
`v<version>` publishes both. So the first published CLI, like the first Superbot release, is newer
than 0.13.0, the last version from Rakazo. The workflow refuses a tag that does not match the CLI
version, and a version already on npm or not newer than every version there.

## Credentials

npm's trusted publishing lets the workflow publish with a short-lived GitHub identity token
instead of a stored secret, but it is set up in the package's own settings on npmjs.com, so the
package must exist first. The first release therefore needs a token, and later releases need
none.

What the owner sets up (names only; never paste a token anywhere but the secret):

1. An npm account that will own `superbot-cli`, with two-factor authentication turned on.
2. For the first release, a granular access token on that account with **Read and write**
   permission on packages, a short expiry, and **Bypass two-factor authentication** enabled so
   the workflow can publish without a one-time code. If npm does not offer `superbot-cli` as a
   choice before it exists, grant all packages and revoke the token right after the release.
3. The token stored as the repository secret **`NPM_TOKEN`** (Settings, Secrets and variables,
   Actions). It is the only secret the workflow reads, and only in its publish job.

npm plans to stop direct publishing with granular access tokens around January 2027. After that
the first release has to be published by the owner by hand, or staged with a stage-only token
(`npm stage publish`) and approved with a one-time code; switch to trusted publishing as soon as
the package exists either way.

### Switch to trusted publishing after the first release

1. On npmjs.com, open `superbot-cli`, Settings, Trusted publishing, and add a GitHub Actions
   publisher: organization or user `z4mbo`, repository `superbot`, workflow filename
   `release-cli.yml`, no environment. Allow direct publishing with `npm publish`: publishers
   added since September 2026 default to staged publishing only. npm does not check these fields
   when they are saved, and a new publisher expires unless it is used within two days, so add it
   just before the next release.
2. Delete the `NPM_TOKEN` secret and revoke the token on npm. Without the secret, the workflow
   publishes through trusted publishing; it needs npm 11.5.1 or later, which the job checks.
3. Optionally, in the package's settings, require two-factor authentication and disallow tokens,
   so only the workflow can publish.

Trusted publishing and provenance need a GitHub-hosted runner, a public repository, and
`repository.url` in the published manifest matching this repository exactly; the workflow and the
generated manifest already meet these.

## First release, step by step

1. Create the npm account and token and add the `NPM_TOKEN` secret, as above.
2. Optionally, run `release-cli` by hand from `main` (a dry run) and check the run and its
   `superbot-cli-npm` artifact.
3. Cut the release with the release skill (`.agents/skills/release/SKILL.md`). Its release pull
   request raises the CLI version with the desktop version; in the same pull request, replace the
   note in `apps/cli/README.md` that the package is not on npm yet.
4. Pushing the tag runs `release-cli` with `release-desktop`. If the tag ran before the secret
   was set, run `release-cli` by hand from that tag with **publish** ticked.
5. Check `npm view superbot-cli`, then `npx superbot-cli@latest --version` on a clean machine.
6. Switch to trusted publishing, as above.

Later releases need nothing beyond the release skill.
