import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "../client/client.js";
import { DEFAULT_SERVER } from "../client/server-origin.js";
import { rememberServer, rememberSignInServer, selectedServer } from "./server-selection.js";
import { useTemporarySettings } from "./settings.test-support.js";

const temporarySettings = useTemporarySettings();

describe("selectedServer", () => {
  it("prefers an explicit server, then SUPERBOT_SERVER, then the saved one, then the default", async () => {
    const { settings } = await temporarySettings();
    const withEnv = (value?: string) => ({ env: { ...settings.env, SUPERBOT_SERVER: value } });
    expect(await selectedServer(undefined, settings)).toBe(DEFAULT_SERVER);
    await rememberServer(new Client("https://saved.example.test"), settings);
    expect(await selectedServer(undefined, settings)).toBe("https://saved.example.test/");
    expect(await selectedServer(" ", withEnv(" "))).toBe("https://saved.example.test/");
    expect(await selectedServer(null, withEnv(" https://env.example.test "))).toBe(
      "https://env.example.test",
    );
    expect(
      await selectedServer(" https://other.example.test ", withEnv("https://env.example.test")),
    ).toBe("https://other.example.test");
    expect(await selectedServer("invalid", settings)).toBe("invalid");
  });

  it("saves only the origin, in the format earlier releases read", async () => {
    const { directory, settings } = await temporarySettings();
    await rememberServer(
      new Client("https://first.example.test").withToken("test.token"),
      settings,
    );
    const file = path.join(directory, "server.txt");
    expect(await readFile(file, "utf8")).toBe("https://first.example.test/\n");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rememberServer(new Client("https://next.example.test"), settings);
    expect(await selectedServer(undefined, settings)).toBe("https://next.example.test/");
    await writeFile(file, "https://example.test/?token=invalid");
    expect(await selectedServer(undefined, settings)).toBe(DEFAULT_SERVER);
  });

  it("keeps the default when signing in to the server named at launch", async () => {
    const { settings } = await temporarySettings();
    const saved = new Client("https://shared.example.test");
    const launch = "http://127.0.0.1:54871";
    await rememberSignInServer(saved, undefined, settings);
    await rememberSignInServer(new Client(launch), ` ${launch} `, settings);
    expect(await selectedServer(undefined, settings)).toBe(saved.server);
    const replacement = new Client("https://second.example.test");
    await rememberSignInServer(replacement, launch, settings);
    expect(await selectedServer(undefined, settings)).toBe(replacement.server);
  });

  it("cannot save without a settings directory", async () => {
    await expect(
      rememberServer(new Client("https://example.test"), { env: {}, platform: "linux" }),
    ).rejects.toThrow("settings directory is unavailable");
  });
});
