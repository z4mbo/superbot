# Desktop parity harness

Internal tools for matching the web and Electron UI to a reference desktop app, screen by screen.
They run against a local dev server with a database of its own; the reference screenshots and any
fixture with real text stay outside the repository.

1. Start `pnpm dev` with `DATABASE_URL`/`DATABASE_MIGRATION_URL` pointing at a fresh database
   (the seed writes rows directly and replaces its account's bots and messages on every run) and
   `PHONE_CALLS_ENABLED=true` so the composer shows its voice controls.
2. Seed: `PARITY_BASE_URL=http://127.0.0.1:5183 PARITY_FIXTURE=<fixture.json> node scripts/parity/seed.mjs`.
   `fixture.example.json` has invented data; a fixture lists the account, the roster sections, and
   each bot with its look (`shape`, `color`), messages (`at`, `key`, `replyTo`, `quote`) and
   whether it is mid-run (`working`). An optional `"workspaces": ["Side projects"]` gives the
   account those extra workspaces (and removes any others), which the `workspace` shot needs; the
   roster then names each workspace in its headings, so seed again without it for the other shots.
3. Capture: `PARITY_OUT=<dir> node scripts/parity/capture.mjs [chat working settings …]` takes
   1280×800 and 1440×900 shots in light and dark at DPR 1 with Chromium.
4. Compare: `PARITY_REFS=<reference screens> PARITY_SHOTS=<dir> PARITY_REPORT=<dir> node scripts/parity/compare.mjs`
   writes a side-by-side, 50% blend and ×3 difference per screen plus `scores.md` (mean absolute
   error per channel and the share of pixels over the threshold).

`font-match.mjs` re-renders reference text samples with open-licence candidate fonts and ranks them
with one weight and tracking per role, which is how the Superbot theme's Inter settings were chosen.
