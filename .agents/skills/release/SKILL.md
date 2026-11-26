---
name: release
description: Prepare a Superbot release - draft the CHANGELOG section from the pull requests merged since the last tag, bump the desktop version, open the release PR, and tag it once merged. Use when asked to cut, prepare, or ship a release or a new version.
---

# Release

Superbot releases ship from `z4mbo/superbot`. Feature pull requests never touch `CHANGELOG.md`; the release writes it in one pass. Tagging publishes to users, so only push a tag when the maintainer asks for that release.

## 1. Gather

```sh
git fetch origin --tags
last="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' origin/main)"
git log --format='%s' "$last"..origin/main | grep -oE '\(#[0-9]+\)$' | tr -d '(#)'
```

Before the first Superbot release there is no `v*` tag; list the merged pull requests instead with `gh pr list -R z4mbo/superbot --state merged --limit 200 --json number,title,mergedAt`.

Read each pull request's title and `## What`/`## Why`/`## Risk` (`gh pr view N -R z4mbo/superbot --json title,body,labels`). With many PRs, fan the reading out to parallel subagents, each returning candidate entries for its slice.

## 2. Draft the section

Pick the version: patch for fixes, minor when users get new capability or self-hosters must act. It must be newer than `version` in `apps/desktop/package.json` and than every published release; sections already in `CHANGELOG.md` from before the first Superbot release belong to Rakazo, which Superbot is based on, so never reuse their versions. Replace `## [Unreleased]` content (fold in anything already there) with `## [X.Y.Z] - YYYY-MM-DD` above the previous release, and leave an empty `## [Unreleased]` on top.

- Order: `### Security`, `### Added`, `### Changed`, `### Removed`, `### Fixed`, then `### Self-host upgrade notes` for anything an operator must do (new required settings, commands to rerun, behavior that changes by default).
- Include what a user or self-hoster would notice. Drop refactors, tests, CI, internal tooling, docs-only and marketing-site changes, and fixes to bugs that never shipped in a release.
- One entry per change, merging PRs that are steps of one feature. Say what changed for the reader in plain words, link the relevant doc, and name settings exactly.
- Every security fix gets an entry. Public repo rules apply: no metrics, private hosts, or account details.
- The desktop app shows this section as the update's release notes, so lead with what users notice.

## 3. Release PR

Bump `apps/desktop/package.json` to the new version in the same branch and open the PR titled `Release vX.Y.Z`. If `pnpm checks` then names compatibility shims that are due, remove them in the same PR. The maintainer reviews the changelog wording there. Right before it merges, rerun the gather against current `main` and add entries for anything merged since, because the tag covers everything up to the release PR's merge commit.

## 4. Tag

After the PR merges, and only when the maintainer asks, tag its merge commit and push the tag:

```sh
sha="$(gh pr view <release PR> -R z4mbo/superbot --json mergeCommit -q .mergeCommit.oid)"
git fetch origin main && git tag vX.Y.Z "$sha" && git push origin vX.Y.Z
```

The tag starts two workflows:

- `release-desktop`: validates the tag (matches the desktop version, has a changelog section, is on `main`, is newer than the latest release), then builds and signs each platform in the `desktop-release` environment: a notarized universal macOS `.dmg` and `.zip`, a signed x64 Windows NSIS installer, and an x64 Linux `.AppImage` (with its update signature) and `.deb`. The publish job checks every update feed against the uploaded assets, writes `SHA256SUMS`, attests build provenance, uploads everything to a draft GitHub release whose text is the changelog section followed by GitHub's generated list of merged pull requests, and only then publishes it as the latest release. Installed apps pick it up from there.
- `publish-server-image`: publishes the `app`, `updater` and `computer` self-host images to `ghcr.io/z4mbo/superbot/<image>`, tagged `vX.Y.Z`, `vX.Y` and `latest`.

Every signing credential must be configured first, or the build fails closed and nothing is published; [desktop releases](../../../docs/desktop-release.md) lists them by name and covers the first-time Linux update key. Check what is set with `gh secret list -R z4mbo/superbot` and `gh variable list -R z4mbo/superbot`.

The command-line client is not part of a release yet. It lives in `apps/cli` as the package `superbot-cli` (command `superbot`), still marked private; the job that publishes it to npm comes in a separate pull request.
