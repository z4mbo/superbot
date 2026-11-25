// A fake local engine for the engine tests: `node engine-fixture.test-support.mjs MODE ...args`.
// MODE picks which engine it imitates; it checks what Superbot sends and answers as that engine would.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, ...args] = process.argv.slice(2);
const emit = (value) => console.log(JSON.stringify(value));
const [command] = args;
if (command === "--version") {
  console.log(
    {
      "grok-headless": "grok 1.0.89 (fixture)",
      gemini: "0.70.0",
      copilot: "GitHub Copilot CLI 1.0.114.",
      opencode: "1.19.6",
    }[mode] ?? "grok 1.0.41 (fixture)",
  );
  process.exit(0);
}
if (mode === "grok-headless") {
  if (command !== "login") assert.equal(process.env.GROK_HOME, process.cwd());
  if (command === "inspect") {
    emit({
      grokVersion: "1.0.89",
      hooks: [],
      skills: [],
      plugins: [],
      marketplaces: [],
      mcpServers: [],
      lspServers: [],
      projectInstructions: [],
      configSources: { layers: [] },
    });
  } else if (command === "models") {
    console.log(
      "Default model: fixture-a\n\nAvailable models:\n  * fixture-a (default)\n  - fixture-b",
    );
  } else if (command === "login") {
    assert.deepEqual(args, ["login", "--oauth"]);
  } else {
    const opt = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(opt("--model"), "fixture-b");
    assert.equal(opt("--sandbox"), "strict");
    assert.equal(opt("--permission-mode"), "dontAsk");
    assert.equal(opt("--tools"), "read_file");
    assert.equal(opt("--disallowed-tools"), "read_file,hashline_read,search_tool,use_tool,Agent");
    assert.ok(args.includes("--no-subagents") && args.includes("--disable-web-search"));
    assert.equal(readFileSync(opt("--prompt-file"), "utf8"), "--always-approve is prompt text");
    emit({ text: "headless reply", stopReason: "end_turn" });
  }
  process.exit(0);
}

if (mode === "copilot") {
  assert.ok(process.env.COPILOT_HOME.startsWith(process.cwd()));
  for (const option of [
    "--available-tools=superbot_no_tools",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--sync-session=off",
  ]) {
    assert.ok(args.includes(option));
  }
  if (args.includes("--silent")) {
    assert.ok(args.includes("--model=two"));
    assert.ok(args.includes("--prompt=--allow-all-tools"));
    console.log("Copilot reply");
    process.exit(0);
  }
}
if (mode === "gemini") {
  const settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
  assert.deepEqual(settings.tools.core, []);
  assert.equal(settings.admin.mcp.enabled, false);
  assert.equal(settings.admin.extensions.enabled, false);
  assert.equal(settings.hooksConfig.enabled, false);
  assert.ok(args.includes("--acp"));
}
if (mode === "opencode") {
  const settings = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(settings.default_agent, "superbot-prompt");
  assert.deepEqual(settings.agent[settings.default_agent].permission, { "*": "deny" });
  assert.equal(process.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
}
const modelOption = (currentValue) => ({
  type: "select",
  category: "model",
  id: "model",
  currentValue,
  options: [
    {
      name: "Group",
      options: [{ value: "one", name: "Actual model" }, { value: "one" }, { value: "two" }],
    },
  ],
});
const restrictedMode = { id: "mode", currentValue: "superbot-prompt" };

const update = (sessionId, text) =>
  emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
let promptId;
let stage = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, ...record } = JSON.parse(line);
  const respond = (result) => emit({ jsonrpc: "2.0", id, result });
  const pi = (data) => emit({ id, type: "response", success: true, command: record.type, data });
  if (mode === "pi") {
    for (const flag of ["--no-tools", "--no-mcp", "--no-extensions", "--no-approve"]) {
      assert.ok(args.includes(flag));
    }
    const model = { provider: "test", id: "one", name: "Pi model" };
    if (record.type === "get_available_models") pi({ models: [model, { ...model, id: "two" }] });
    else if (record.type === "get_state") pi({ model });
    else if (record.type === "set_model") {
      assert.equal(record.provider, "test");
      assert.equal(record.modelId, "two");
      pi({});
    } else if (record.type === "prompt") {
      pi({});
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Pi reply" },
      });
      emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    } else assert.fail(record.type);
    continue;
  }
  switch (method) {
    case "initialize":
      assert.deepEqual(params.clientCapabilities, {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
      respond({
        protocolVersion: 1,
        agentInfo: {
          gemini: { name: "gemini-cli", version: "0.70.0" },
          copilot: { name: "Copilot", version: "1.0.114" },
          opencode: { name: "OpenCode", version: "1.19.6" },
        }[mode],
        authMethods: [{ id: "browser-auth", name: "Browser" }],
        _meta: { grokShell: true, agentVersion: "1.0.41" },
      });
      break;
    case "authenticate":
      assert.equal(mode, "vibe");
      assert.equal(params.methodId, "browser-auth");
      respond({});
      break;
    case "session/new":
      assert.deepEqual(params.mcpServers, []);
      assert.equal(params.cwd.replace(/^\\\\\?\\/, ""), process.cwd());
      if (mode === "signed-out") {
        emit({ jsonrpc: "2.0", id, error: { code: -32000, message: "signed out" } });
        break;
      }
      if (params._meta || mode === "grok-mcp") {
        const profile = params._meta.agentProfile;
        assert.equal(profile.injectDefaultTools, false);
        assert.equal(profile.discoverSkills, false);
        assert.deepEqual(profile.disallowedTools, ["read_file"]);
      }
      respond({ sessionId: "session", configOptions: [modelOption("one"), restrictedMode] });
      break;
    case "_x.ai/mcp/list":
      respond({
        result: {
          sessionMcpResolved: true,
          servers: mode === "grok-mcp" ? [{ session: { enabled: true } }] : [],
        },
      });
      break;
    case "session/set_model":
      assert.equal(mode, "gemini");
      assert.equal(params.modelId, "two");
      respond({});
      break;
    case "session/set_config_option":
      assert.equal(mode, "opencode");
      assert.equal(params.configId, "model");
      assert.equal(params.value, "two");
      respond({ configOptions: [modelOption("two"), restrictedMode] });
      break;
    case "session/prompt":
      assert.equal(params.prompt[0].type, "text");
      if (mode === "gemini" || mode === "opencode") {
        if (params.prompt[0].text === "unexpected tool") {
          emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: { sessionUpdate: "tool_call" },
            },
          });
          break;
        }
        assert.equal(params.prompt[0].text, "User message:\n/auth");
        update(params.sessionId, mode === "gemini" ? "Gemini reply" : "OpenCode reply");
        respond({ stopReason: "end_turn" });
        break;
      }
      if (params.prompt[0].text === "hang") break;
      promptId = id;
      emit({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {} });
      break;
    case undefined:
      if (stage++ === 0) {
        assert.equal(id, "permission");
        assert.deepEqual(record.result, { outcome: { outcome: "cancelled" } });
        emit({ jsonrpc: "2.0", id: "fs", method: "fs/read_text_file", params: {} });
      } else {
        assert.equal(id, "fs");
        assert.equal(record.error.code, -32601);
        update("wrong-session", "ignored");
        update("session", "ACP ");
        update("session", "reply");
        emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        stage = 0;
      }
      break;
    default:
      assert.fail(method);
  }
}
