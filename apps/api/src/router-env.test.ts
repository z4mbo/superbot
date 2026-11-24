import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { routerEnv } from "./router-env.js";

const base = {
  DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  NODE_ENV: "test",
};

describe("routerEnv", () => {
  it("hands the router the test plugin hosts the API env lists", () => {
    const env = loadEnv({
      ...base,
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
      SUPERBOT_E2E_ALLOW_PLUGIN_HOSTS: "127.0.0.1",
    });
    expect(routerEnv(env)).toMatchObject({
      mcpAllowPrivateEndpoint: true,
      e2ePluginHosts: ["127.0.0.1"],
    });
  });
});
