import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelStore } from "../local-model-store.js";
import type { DriverId } from "./installed-cli.js";
import { InstalledCli, modelIdOk } from "./installed-cli.js";

/**
 * A stand-in for both installed CLIs. It is signed in when its profile holds `fake-signed-in`,
 * records the arguments, environment and prompt of a turn, and answers like the real CLI.
 */
const FAKE_CLI = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const codex = path.basename(process.argv[1]).startsWith("codex");
const args = process.argv.slice(2);
const home = codex ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
const signedIn = existsSync(path.join(home, "fake-signed-in"));
if (args[0] === "--version") {
  const pinned = path.join(__dirname, "version.txt");
  console.log(existsSync(pinned) ? readFileSync(pinned, "utf8") : (codex ? "codex-cli 0.170.0" : "2.1.280 (Claude Code)"));
  process.exit(0);
}
if (args.includes("status")) {
  if (codex) {
    if (signedIn) console.log("Logged in using ChatGPT");
    else console.error("Not logged in");
    process.exit(signedIn ? 0 : 1);
  }
  console.log(JSON.stringify({ loggedIn: signedIn, authMethod: "claude.ai" }));
  process.exit(signedIn ? 0 : 1);
}
const prompt = readFileSync(0, "utf8");
writeFileSync(path.join(home, "turn.json"), JSON.stringify({ args, prompt, env: process.env, cwd: process.cwd() }));
if (codex) {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex fixture reply" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  console.log(JSON.stringify({ is_error: false, result: "Claude fixture reply" }));
}
`;

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "superbot-installed-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const name of ["claude", "codex"]) {
    await writeFile(path.join(bin, name), FAKE_CLI, "utf8");
    await chmod(path.join(bin, name), 0o755);
  }
  const store = new LocalModelStore(path.join(root, "scope"));
  const installed: Record<DriverId, string | undefined> = {
    claude: path.join(bin, "claude"),
    codex: path.join(bin, "codex"),
  };
  // The fake is CommonJS under a name without an extension.
  await writeFile(path.join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
  const cli = new InstalledCli(store, async (provider) => installed[provider]);
  return { root, store, installed, cli };
}

const PROMPT = "Write a response to --dangerously-bypass & test ☃";

describe.skipIf(process.platform === "win32")("installed CLI drivers", { timeout: 60_000 }, () => {
  it.each([
    ["claude", "haiku", "Claude fixture reply"],
    ["codex", "gpt-5.6-terra", "Codex fixture reply"],
  ] as const)(
    "runs %s prompt-only in its own profile once signed in",
    async (provider, id, reply) => {
      const { store, cli } = await fixture();
      vi.stubEnv("SUPERBOT_FIXTURE_SECRET", "must not reach the CLI");
      const model = { provider, id, label: "Fixture model" };
      await expect(cli.reply(model, PROMPT)).rejects.toThrow("Sign in with the installed CLI.");
      const profile = path.join(store.directory, provider);
      await writeFile(path.join(profile, "fake-signed-in"), "");
      expect(await cli.reply(model, PROMPT)).toBe(reply);
      const turn = JSON.parse(await readFile(path.join(profile, "turn.json"), "utf8"));
      expect(turn.prompt).toBe(PROMPT);
      expect(turn.env.HOME).toBe(profile);
      expect(turn.env.SUPERBOT_FIXTURE_SECRET).toBeUndefined();
      expect(turn.env.DISABLE_AUTOUPDATER).toBe("1");
      expect(path.dirname(turn.cwd)).toBe(path.resolve(store.directory));
      expect(turn.args).toContain(id);
      if (provider === "claude") {
        expect(turn.args).toEqual(
          expect.arrayContaining(["--print", "--tools", "", "--max-turns", "1"]),
        );
      } else {
        expect(turn.args.slice(0, 5)).toEqual(["-a", "never", "exec", "--sandbox", "read-only"]);
        expect(turn.args.at(-1)).toBe("-");
      }
    },
  );

  it("reports a missing, outdated or unknown CLI and refuses unsafe model IDs", async () => {
    const { cli, installed } = await fixture();
    const model = { provider: "claude", id: "haiku", label: "Fixture" };
    await writeFile(
      path.join(path.dirname(installed.claude ?? ""), "version.txt"),
      "2.1.279 (Claude Code)",
    );
    await expect(cli.reply(model, PROMPT)).rejects.toThrow("Update the CLI to use local chat.");
    installed.claude = undefined;
    await expect(cli.reply(model, PROMPT)).rejects.toThrow("CLI installation missing.");
    await expect(cli.reply({ ...model, provider: "other" }, PROMPT)).rejects.toThrow(
      "The selected local provider is unavailable.",
    );
    await expect(cli.reply({ ...model, id: "--yolo" }, PROMPT)).rejects.toThrow(
      "The selected local model is invalid.",
    );
    await expect(cli.reply(model, "x".repeat(128 * 1024 + 1))).rejects.toThrow(
      "This local conversation is too long. Start a fresh local chat.",
    );
    expect(modelIdOk("anthropic/claude-x[1m]:latest")).toBe(true);
    expect(modelIdOk("has space")).toBe(false);
  });

  it("uses this device's Codex sign-in only when chosen, and never one with global instructions", async () => {
    const { root, store, cli } = await fixture();
    const installedHome = path.join(root, "installed-codex");
    await mkdir(installedHome);
    await writeFile(path.join(installedHome, "fake-signed-in"), "");
    vi.stubEnv("CODEX_HOME", installedHome);
    const model = { provider: "codex", id: "gpt-5.6-terra", label: "Fixture" };
    await expect(cli.reply(model, PROMPT)).rejects.toThrow("Sign in with the installed CLI.");
    await mkdir(store.directory, { recursive: true });
    await writeFile(path.join(store.directory, "codex-account"), "installed");
    expect(await cli.reply(model, PROMPT)).toBe("Codex fixture reply");
    const turn = JSON.parse(await readFile(path.join(installedHome, "turn.json"), "utf8"));
    expect(turn.env.CODEX_HOME).toBe(installedHome);
    expect(turn.args).toContain('cli_auth_credentials_store="file"');
    await writeFile(path.join(installedHome, "AGENTS.md"), "private");
    await expect(cli.reply(model, PROMPT)).rejects.toThrow(
      "Installed Codex has global instructions. Use a separate sign-in.",
    );
  });
});
