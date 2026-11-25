import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { executableAt, executableName, pathDirectories } from "../process.js";
import type { Engine } from "./engine.js";
import { at } from "./engine.js";

/** The local engines a selection can name, how each is installed, and the arguments it runs with. */
const ENGINES: Record<string, { program: string; args: string[]; protocol: Engine["protocol"] }> = {
  grok: {
    program: "grok",
    args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
    protocol: "acp",
  },
  kimi: { program: "kimi", args: ["acp"], protocol: "acp" },
  droid: { program: "droid", args: ["exec", "-o", "acp"], protocol: "acp" },
  cursor: { program: "cursor-agent", args: ["acp"], protocol: "acp" },
  githubCopilot: { program: "copilot", args: ["--acp", "--stdio"], protocol: "acp" },
  commandCode: { program: "command-code", args: ["acp"], protocol: "acp" },
  kiro: {
    program: "kiro-cli",
    args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    protocol: "acp",
  },
  devin: { program: "devin", args: ["acp"], protocol: "acp" },
  opencodeGo: { program: "opencode", args: ["acp"], protocol: "acp" },
  mistralVibe: { program: "vibe-acp", args: [], protocol: "acp" },
  deepseek: { program: "dsh", args: ["--profile", "acp"], protocol: "acp" },
  qwen: { program: "qwen", args: ["--acp"], protocol: "acp" },
  hermes: { program: "hermes", args: ["acp"], protocol: "acp" },
  cline: { program: "cline", args: ["--acp", "--auto-approve", "false"], protocol: "acp" },
  pi: {
    program: "pi",
    args: [
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-approve",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
    ],
    protocol: "pi",
  },
  omp: { program: "omp", args: ["acp"], protocol: "acp" },
  gemini: { program: "gemini", args: ["--acp"], protocol: "acp" },
};

/** The npm packages whose JavaScript entry is started with Node on Windows instead of a shim. */
const NPM_PACKAGES: Record<string, string> = {
  kimi: "@moonshot-ai/kimi-code",
  githubCopilot: "@github/copilot",
  opencodeGo: "opencode-ai",
  cline: "cline",
  pi: "@earendil-works/pi-coding-agent",
  omp: "@oh-my-pi/pi-coding-agent",
  gemini: "@google/gemini-cli",
};

/** The installed engine for a provider ID, found only among the known engines and on PATH. */
export async function discoverEngine(
  id: string,
  directories: string[] = pathDirectories(),
): Promise<Engine | undefined> {
  if (!Object.hasOwn(ENGINES, id)) return undefined;
  const known = ENGINES[id];
  if (!known) return undefined;
  const engine = (program: string, script?: string): Engine => ({
    id,
    protocol: known.protocol,
    program,
    launcherArgs: script === undefined ? [] : [script],
    args: [...known.args],
  });
  const name = executableName(known.program);
  for (const directory of directories) {
    const found = await executableAt(path.join(directory, name));
    if (found) return engine(found);
    if (process.platform === "win32") {
      const entry = await npmEntry(id, known.program, directory, directories);
      if (entry) return engine(entry.program, entry.script);
    }
  }
  if (id === "grok") {
    const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
    if (!home) return undefined;
    const found = await executableAt(path.join(home, ".grok", "bin", name));
    return found ? engine(found) : undefined;
  }
  if (id === "cursor" && process.platform === "win32") {
    const entry = await cursorEntry();
    if (entry) return engine(entry.program, entry.script);
  }
  return undefined;
}

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

async function canonical(file: string): Promise<string | undefined> {
  return realpath(file).catch(() => undefined);
}

/** Resolves a known npm package's JavaScript entry without running or interpreting its shim. */
async function npmEntry(
  id: string,
  name: string,
  directory: string,
  directories: string[],
): Promise<{ program: string; script?: string } | undefined> {
  const pkg = NPM_PACKAGES[id];
  if (!pkg) return undefined;
  if (!(await stat(path.join(directory, `${name}.cmd`)).catch(() => undefined))?.isFile()) {
    return undefined;
  }
  const modules =
    path.basename(directory) === ".bin"
      ? path.dirname(directory)
      : path.join(directory, "node_modules");
  const root = await canonical(path.join(modules, pkg));
  if (!root) return undefined;
  const metadata = await readSmallJson(path.join(root, "package.json"), 262_144);
  if (at(metadata, "name") !== pkg) return undefined;
  if (id === "githubCopilot") {
    const arch = { x64: "x64", arm64: "arm64" }[process.arch as string];
    if (!arch) return undefined;
    const platformPackage = `@github/copilot-win32-${arch}`;
    let platformRoot: string | undefined;
    for (const base of [path.join(root, "node_modules"), modules]) {
      platformRoot = await canonical(path.join(base, platformPackage));
      if (platformRoot) break;
    }
    if (!platformRoot) return undefined;
    const program = await executableAt(path.join(platformRoot, "copilot.exe"));
    return program && inside(program, platformRoot) ? { program } : undefined;
  }
  const bin = at(metadata, "bin");
  const relative = typeof bin === "string" ? bin : at(bin, name);
  if (typeof relative !== "string") return undefined;
  const entry = await canonical(path.join(root, relative));
  if (!entry) return undefined;
  if (id === "opencodeGo" && inside(entry, root)) {
    const program = await executableAt(entry);
    return program ? { program } : undefined;
  }
  if (
    !inside(entry, root) ||
    !(await stat(entry).catch(() => undefined))?.isFile() ||
    ![".js", ".mjs", ".cjs"].includes(path.extname(entry))
  ) {
    return undefined;
  }
  let node = await executableAt(path.join(directory, "node.exe"));
  for (const other of directories) {
    if (node) break;
    node = await executableAt(path.join(other, "node.exe"));
  }
  return node ? { program: node, script: entry } : undefined;
}

/** The newest version folder of the Windows cursor-agent install, run with its own Node. */
async function cursorEntry(): Promise<{ program: string; script: string } | undefined> {
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const root = path.join(local, "cursor-agent");
  if (!path.isAbsolute(root)) return undefined;
  if (!(await stat(path.join(root, "cursor-agent.ps1")).catch(() => undefined))?.isFile()) {
    return undefined;
  }
  const versions = await canonical(path.join(root, "versions"));
  if (!versions) return undefined;
  const names = await readdir(versions).catch(() => [] as string[]);
  const candidates = names.flatMap((name) => {
    const dash = name.indexOf("-");
    if (dash === -1) return [];
    const parts = name.slice(0, dash).split(".");
    const suffix = name.slice(dash + 1);
    if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return [];
    if (!/^[0-9A-Fa-f-]*$/.test(suffix)) return [];
    return [{ date: parts.map(Number), name }];
  });
  candidates.sort((a, b) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = (a.date[index] ?? 0) - (b.date[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const candidate of candidates.reverse()) {
    const version = await canonical(path.join(versions, candidate.name));
    if (!version) continue;
    const script = await canonical(path.join(version, "index.js"));
    const node = await executableAt(path.join(version, "node.exe"));
    if (
      script &&
      node &&
      inside(version, versions) &&
      inside(script, version) &&
      inside(node, version)
    ) {
      return { program: node, script };
    }
  }
  return undefined;
}

async function readSmallJson(file: string, limit: number): Promise<unknown> {
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
      if (bytesRead > limit) return undefined;
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** A known engine started as `program` with `launcherArgs` first, as discovery would start it. */
export function knownEngine(
  id: string,
  program: string,
  launcherArgs: string[],
): Engine | undefined {
  const known = Object.hasOwn(ENGINES, id) ? ENGINES[id] : undefined;
  return known && { id, protocol: known.protocol, program, launcherArgs, args: [...known.args] };
}
