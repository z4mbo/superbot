import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./dev-desktop.sh", import.meta.url));
const unix = process.platform !== "win32";

test("desktop watcher reports usage for incomplete or unexpected arguments", {
  skip: !unix,
}, () => {
  const help = execFileSync("sh", [script, "--help"], { encoding: "utf8" });
  assert.match(help, /\[--server URL\]/);
  assert.match(help, /--reset-session/);
  for (const args of [["--server"], ["--server", "--help"], ["--other"]]) {
    const result = spawnSync("sh", [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});

test("desktop watcher rebuilds without clearing sessions unless reset is explicitly requested", {
  skip: !unix,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "superbot-dev-test-"));
  try {
    const bin = join(root, "bin");
    const watcher = join(root, "scripts/dev-desktop.sh");
    for (const directory of ["scripts", "bin", "native", "target/debug"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    copyFileSync(script, watcher);
    writeFileSync(join(root, "Cargo.toml"), "");
    const mock = (name, body) =>
      writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    mock("bin/uname", "echo Darwin");
    mock("bin/node", `exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"`);
    mock("bin/cargo", 'printf "cargo %s [%s]\\n" "$*" "$SUPERBOT_SERVER"');
    mock("bin/security", 'printf "%s\\n" "$*" >> keychain.log; exit 44');
    mock("target/debug/superbot-desktop", "exit 0");
    mock(
      "bin/sleep",
      `if [ ! -f tick ]; then
    touch native/new-file
    echo 1 > tick
else
    case "$(cat tick)" in
        1) touch -t 209901010000 Cargo.toml; echo 2 > tick ;;
        2) touch -t 200001010000 Cargo.toml; rm native/new-file; echo 3 > tick ;;
        3) echo 4 > tick ;;
        4) exit 1 ;;
    esac
fi`,
    );

    const options = {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        CARGO_TARGET_DIR: join(root, "target"),
        SUPERBOT_SERVER: "https://saved.example",
        TMPDIR: root,
      },
      timeout: 5000,
    };
    const keychainLog = join(root, "keychain.log");
    function run(args, server) {
      rmSync(join(root, "tick"), { force: true });
      const result = spawnSync("sh", [watcher, ...args], options);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.stdout.split("\n").filter((line) => line.startsWith("cargo ")),
        Array(4).fill(`cargo build --locked -p superbot-desktop [${server}]`),
      );
      return result.stdout;
    }

    run([], "https://saved.example");
    run(["--server", "HTTPS://Fixture.Example:443"], "HTTPS://Fixture.Example:443");
    assert.equal(existsSync(keychainLog), false);

    const inherited = spawnSync("sh", [watcher, "--reset-session"], options);
    assert.equal(inherited.status, 2);
    assert.match(inherited.stderr, /requires an explicit --server URL/);
    const invalid = spawnSync(
      "sh",
      [watcher, "--server", "https://fixture.example/other", "--reset-session"],
      options,
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /must be an HTTPS origin/);
    assert.equal(existsSync(keychainLog), false);

    const stdout = run(
      ["--reset-session", "--server", "HTTPS://Fixture.Example:443"],
      "HTTPS://Fixture.Example:443",
    );
    assert.match(stdout.trimStart().split("\n")[0], /will remove .* https:\/\/fixture\.example\//);
    assert.deepEqual(
      readFileSync(keychainLog, "utf8").trim().split("\n"),
      Array(4).fill(
        "delete-generic-password -s com.superbot.rakazo.session -a https://fixture.example/",
      ),
    );
    assert.match(stdout, /no keychain session for https:\/\/fixture\.example\//);

    mock("bin/uname", "echo Linux");
    const linux = spawnSync(
      "sh",
      [watcher, "--server", "https://fixture.example", "--reset-session"],
      options,
    );
    assert.equal(linux.status, 2);
    assert.match(linux.stderr, /is available on macOS only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
