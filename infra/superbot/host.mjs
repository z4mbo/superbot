import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
const usage =
  "Usage: node infra/superbot/host.mjs <init|up|status|logs|account|down> [--env FILE] [--project NAME] [--port PORT] [--origin URL]";
const options = new Map();

function parseOptions() {
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !["--env", "--project", "--port", "--origin"].includes(option) ||
      !value ||
      value.startsWith("--") ||
      options.has(option)
    ) {
      throw new Error(usage);
    }
    options.set(option, value);
  }
  if (command !== "init" && (options.has("--port") || options.has("--origin"))) {
    throw new Error(
      "--port and --origin apply to init. Edit the environment file for an existing stack.",
    );
  }
}

function initialize(envFile) {
  const port = options.get("--port") ?? "5173";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("--port must be between 1 and 65535.");
  }
  const origin = new URL(options.get("--origin") ?? `http://127.0.0.1:${Number(port)}`);
  const local = ["127.0.0.1", "localhost"].includes(origin.hostname);
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("--origin must be an HTTPS origin or a loopback HTTP origin.");
  }

  const secret = () => randomBytes(32).toString("hex");
  const settings = {
    SUPERBOT_PORT: Number(port),
    POSTGRES_PASSWORD: secret(),
    POSTGRES_APP_PASSWORD: secret(),
    BETTER_AUTH_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    SCREEN_PROXY_SECRET: secret(),
    SANDBOX_SUPERVISOR_TOKEN: secret(),
    WEB_ORIGIN: origin.origin,
    BETTER_AUTH_URL: origin.origin,
    RAKAZO_HOST: origin.hostname,
    AUTH_PASSWORD_ENABLED: "true",
    SIGNUPS_ENABLED: local ? "true" : "false",
    EMAIL_PROVIDER: "none",
  };
  const contents = Object.entries(settings)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  writeFileSync(envFile, contents, { flag: "wx", mode: 0o600 });
  console.log(`Created ${envFile} for ${origin.origin}`);
}

function main() {
  const commands = {
    up: ["up", "--build", "--detach", "--wait", "postgres", "api", "worker", "web"],
    status: ["ps", "--all"],
    logs: ["logs", "--tail", "100", "postgres", "migrate", "api", "worker", "web"],
    account: [
      "exec",
      "-T",
      "-e",
      "OWNER_EMAIL",
      "-e",
      "OWNER_PASSWORD",
      "api",
      "node",
      "dist/cli/bootstrap-owner.js",
    ],
    down: ["down"],
  };
  if (command !== "init" && !Object.hasOwn(commands, command)) throw new Error(usage);
  parseOptions();
  const envFile = resolve(options.get("--env") ?? resolve(root, ".env.superbot.local"));
  const project = options.get("--project") ?? "superbot";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error("Invalid Compose project name.");
  if (command === "init") {
    initialize(envFile);
    return;
  }
  const settings = parseEnv(readFileSync(envFile, "utf8"));
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      envFile,
      "-f",
      resolve(root, "infra/compose/docker-compose.yml"),
      "-f",
      resolve(root, "infra/superbot/compose.yml"),
      ...commands[command],
    ],
    { cwd: root, env: { ...process.env, ...settings }, stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT")
    throw new Error("Docker CLI with the Compose plugin is required.");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (command === "up" && result.status === 0)
    console.log(`Superbot containers are healthy. The configured origin is ${settings.WEB_ORIGIN}`);
}

try {
  main();
} catch (error) {
  console.error(
    error.code === "EEXIST"
      ? "Environment file already exists. Keep its credentials and edit it in place."
      : error.message,
  );
  process.exitCode = 1;
}
