import { describe, expect, it } from "vitest";
import { FIND_TOOL } from "../../tools/builtin.tool-definition.js";
import { CORE_BUILTIN_TOOL_NAMES, partitionTools } from "../../tools/builtin-tool-bridge.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  READ_ONLY_AGENT_TOOLS,
  selectBuiltinToolsForRun,
  unavailableBuiltinToolReasons,
} from "./run-tool-selection.js";

const none: { name: string }[] = [];

describe("spawn_bot selection", () => {
  it.each(["user", "bot_message", "webhook"])("checks fleet management for a %s run", (trigger) => {
    const names = (fleetManagement: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        fleetManagement,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("spawn_bot");
    expect(names(false)).not.toContain("spawn_bot");
  });
});

describe("messaging channel selection", () => {
  it("drops shared memory and MCP server removal where shared memory saves are dropped", () => {
    const names = (messagingChannelRun: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun,
      }).map((tool) => tool.name);

    for (const name of ["save_shared_memory", "delete_shared_memory", "remove_mcp_server"]) {
      expect(names(false)).toContain(name);
      expect(names(true)).not.toContain(name);
    }
  });
});

describe("unavailableBuiltinToolReasons", () => {
  it("explains a group thread's missing message_bot and points to handoff_to_bot", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: "g", trigger: "user" }, [
      { name: "handoff_to_bot" },
    ]);

    expect(reasons.message_bot).toBe(
      "message_bot is not available in group threads. Use handoff_to_bot with the group_id and the member's bot_id instead.",
    );
  });

  it("does not point to handoff_to_bot when the run was not offered it", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: "g", trigger: "user" }, none);

    expect(reasons.message_bot).toBe("message_bot is not available in group threads.");
  });

  it("explains a creation intro's missing tools and keeps ask_user and update_bot out of it", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: null, trigger: "created" }, none);

    expect(reasons.message_user).toBe(
      "message_user is not available until the user says what this bot is for. Use ask_user.",
    );
    expect(reasons).not.toHaveProperty("ask_user");
    expect(reasons).not.toHaveProperty("update_bot");
  });

  it("explains a background run's dropped messaging and media tools", () => {
    const reasons = unavailableBuiltinToolReasons({ groupId: null, trigger: "tickets" }, none);

    expect(reasons.message_bot).toBe(
      "message_bot is not available in a background run. Report through ticket_comment instead.",
    );
    expect(reasons.generate_image).toBe(
      "generate_image is not available in a background run. Report through ticket_comment instead.",
    );
  });

  it("explains a tool the bot turned off", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["message_user"] },
      none,
    );

    expect(reasons.message_user).toBe("message_user is turned off for this bot.");
  });

  it("gives a creation intro's disabled tool the creation reason first", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "created", disabledBuiltinTools: ["message_user"] },
      none,
    );

    expect(reasons.message_user).toBe(
      "message_user is not available until the user says what this bot is for. Use ask_user.",
    );
  });

  it("gives no reason to a tool that was offered", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: "g", trigger: "tickets", disabledBuiltinTools: ["message_user"] },
      [{ name: "message_bot" }, { name: "message_user" }],
    );

    expect(reasons).not.toHaveProperty("message_bot");
    expect(reasons).not.toHaveProperty("message_user");
  });

  it("gives no reason to a name that is not a built-in", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: "g", trigger: "tickets", disabledBuiltinTools: ["not_a_tool"] },
      none,
    );

    expect(reasons).not.toHaveProperty("not_a_tool");
    for (const name of Object.keys(reasons)) expect(BUILTIN_AGENT_TOOL_NAMES.has(name)).toBe(true);
  });
});

describe("workspace tool selection", () => {
  const WORKSPACE_TOOLS = ["edit_file", "search_files", "glob", "process_manage"];
  const names = (options: { trigger?: string; disabledBuiltinTools?: string[] } = {}) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: options.trigger ?? "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      disabledBuiltinTools: options.disabledBuiltinTools,
    }).map((tool) => tool.name);

  it("offers the workspace tools beside the file tools and shell", () => {
    const offered = names();
    for (const name of ["read_file", "write_file", "list_files", "shell", ...WORKSPACE_TOOLS]) {
      expect(offered).toContain(name);
    }
    // The creation intro offers neither the file tools nor these.
    const created = names({ trigger: "created" });
    for (const name of ["read_file", "write_file", "shell", ...WORKSPACE_TOOLS]) {
      expect(created).not.toContain(name);
    }
  });

  it("turns each off with the tool it does part of the job of", () => {
    const cases: [string, string[]][] = [
      ["write_file", ["edit_file"]],
      ["read_file", ["search_files"]],
      ["list_files", ["glob"]],
      ["shell", ["process_manage"]],
    ];
    for (const [parent, followers] of cases) {
      const offered = names({ disabledBuiltinTools: [parent] });
      for (const name of followers) expect(offered).not.toContain(name);
      const others = WORKSPACE_TOOLS.filter((name) => !followers.includes(name));
      for (const name of others) expect(offered).toContain(name);
      const reasons = unavailableBuiltinToolReasons(
        { groupId: null, trigger: "user", disabledBuiltinTools: [parent] },
        offered.map((name) => ({ name })),
      );
      for (const name of followers) expect(reasons[name]).toBeDefined();
    }
    // Each can also be turned off alone.
    const offered = names({ disabledBuiltinTools: ["process_manage"] });
    expect(offered).toContain("shell");
    expect(offered).not.toContain("process_manage");
  });
});

describe("page control tool selection", () => {
  const CONTROL = ["browser_cdp", "browser_dialog"];
  const names = (options: Partial<Parameters<typeof selectBuiltinToolsForRun>[0]> = {}) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: true,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      ...options,
    }).map((tool) => tool.name);

  it("offers browser_cdp and browser_dialog exactly where the other page tools are", () => {
    for (const pageBrowserAllowed of [true, false]) {
      const offered = names({ pageBrowserAllowed });
      for (const name of CONTROL)
        expect(offered.includes(name), `${name} ${pageBrowserAllowed}`).toBe(
          offered.includes("browser_act"),
        );
    }
    expect(names({ graphicalToolsAllowed: false })).not.toContain("browser_cdp");
  });

  it("turns both off with browser_act, and each alone", () => {
    const withoutAct = names({ disabledBuiltinTools: ["browser_act"] });
    for (const name of CONTROL) expect(withoutAct).not.toContain(name);
    expect(withoutAct).toContain("browser_snapshot");
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["browser_act"] },
      withoutAct.map((name) => ({ name })),
    );
    for (const name of CONTROL) expect(reasons[name]).toBeDefined();
    const withoutCdp = names({ disabledBuiltinTools: ["browser_cdp"] });
    expect(withoutCdp).toContain("browser_dialog");
    expect(withoutCdp).toContain("browser_act");
    expect(withoutCdp).not.toContain("browser_cdp");
  });
});

describe("task thread selection", () => {
  const TASK_TOOLS = ["delegate", "follow_up", "stop_task", "link_to_thread"];
  const names = (options: Partial<Parameters<typeof selectBuiltinToolsForRun>[0]> = {}) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      ...options,
    }).map((tool) => tool.name);

  it("offers the task thread tools and the check-in offer in the owner's own app chat", () => {
    const offered = names();
    expect(offered).toEqual(expect.arrayContaining([...TASK_TOOLS, "offer_check_in"]));
    expect(offered).toContain("run_subagent");
    expect(offered).toContain("schedule_create");
  });

  it.each([
    ["a helper's own run", { trigger: "helper" }],
    ["a helper's result", { trigger: "helper_result" }],
    ["a routine", { trigger: "routine" }],
    ["a webhook", { trigger: "webhook" }],
    ["a group", { groupId: "group" }],
    ["a chat app's conversation", { externalConversation: true }],
    ["a task thread, so delegation stays one level deep", { taskThread: true }],
    ["another person's chat-app message", { trigger: "messaging", messagingChannelRun: true }],
  ])("hides the task thread tools in %s", (_where, options) => {
    const offered = names(options);
    for (const name of TASK_TOOLS) expect(offered).not.toContain(name);
  });

  it("turns the tools that act on task threads off with delegate", () => {
    const offered = names({ disabledBuiltinTools: ["delegate"] });
    for (const name of TASK_TOOLS) expect(offered).not.toContain(name);
    expect(offered).toContain("run_subagent");
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["delegate"] },
      offered.map((name) => ({ name })),
    );
    for (const name of TASK_TOOLS) expect(reasons[name]).toBeDefined();
    // Each can also be turned off alone.
    const withoutStop = names({ disabledBuiltinTools: ["stop_task"] });
    expect(withoutStop).toContain("delegate");
    expect(withoutStop).not.toContain("stop_task");
  });

  it("hides delegation where run_subagent is hidden", () => {
    const helper = names({ trigger: "helper" });
    expect(helper).not.toContain("run_subagent");
    expect(helper).not.toContain("delegate");
  });

  it("offers a check-in only where the run may set its own follow-ups", () => {
    expect(names({ groupId: "group" })).toContain("offer_check_in");
    for (const options of [
      { trigger: "routine" },
      { trigger: "helper" },
      { trigger: "bot_message" },
      { trigger: "messaging", messagingChannelRun: true },
      { disabledBuiltinTools: ["schedule_create"] },
    ]) {
      expect(names(options)).not.toContain("offer_check_in");
    }
  });
});

describe("keyed research tool selection", () => {
  const names = (researchTools?: ReadonlySet<string>, disabledBuiltinTools?: string[]) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      researchTools,
      disabledBuiltinTools,
    }).map((tool) => tool.name);

  it("offers web_search and web_fetch, but no keyed tool, without a saved key", () => {
    const offered = names();
    expect(offered).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(offered).not.toContain("exa_search");
    expect(offered).not.toContain("firecrawl_scrape");
  });

  it("offers only the tool whose provider has a saved key", () => {
    expect(names(new Set(["exa_search"]))).toContain("exa_search");
    expect(names(new Set(["exa_search"]))).not.toContain("firecrawl_scrape");
    const both = names(new Set(["exa_search", "firecrawl_scrape"]));
    expect(both).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "exa_search", "firecrawl_scrape"]),
    );
  });

  it("never offers a keyed tool to a chat app's messages, which spend its owner's key", () => {
    const offered = selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "messaging",
      semanticMemoryEnabled: false,
      messagingChannelRun: true,
      researchTools: new Set(["exa_search", "firecrawl_scrape"]),
    }).map((tool) => tool.name);
    expect(offered).toContain("web_search");
    expect(offered).not.toContain("exa_search");
    expect(offered).not.toContain("firecrawl_scrape");
  });

  it("keeps a keyed tool the bot turned off off", () => {
    expect(names(new Set(["exa_search"]), ["exa_search"])).not.toContain("exa_search");
  });

  it("explains a keyed tool without a key, and a turned-off one as turned off", () => {
    const reasons = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["firecrawl_scrape"] },
      none,
    );
    expect(reasons.exa_search).toContain("web_search and web_fetch");
    expect(reasons.firecrawl_scrape).toBe("firecrawl_scrape is turned off for this bot.");
    const withKey = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", researchTools: new Set(["exa_search"]) },
      [{ name: "exa_search" }],
    );
    expect(withKey.exa_search).toBeUndefined();
  });
});

describe("media understanding selection", () => {
  const names = (options: {
    imageUnderstandingAvailable?: boolean;
    videoUnderstandingAvailable?: boolean;
  }) =>
    selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
      ...options,
    }).map((tool) => tool.name);

  it("offers each analysis tool only when a connected model reads that kind", () => {
    expect(names({})).not.toContain("vision_analyze");
    expect(names({})).not.toContain("video_analyze");
    expect(names({ imageUnderstandingAvailable: true })).toContain("vision_analyze");
    expect(names({ imageUnderstandingAvailable: true })).not.toContain("video_analyze");
    expect(names({ videoUnderstandingAvailable: true })).toContain("video_analyze");
    expect(names({ videoUnderstandingAvailable: true })).not.toContain("vision_analyze");
  });

  it("tells a stale call that no connected model reads that kind", () => {
    const offered = names({ imageUnderstandingAvailable: true }).map((name) => ({ name }));
    const reasons = unavailableBuiltinToolReasons({ groupId: null, trigger: "user" }, offered);
    expect(reasons.vision_analyze).toBeUndefined();
    expect(reasons.video_analyze).toMatch(/^No connected model can read video/);
    const none = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user" },
      names({}).map((name) => ({ name })),
    );
    expect(none.vision_analyze).toMatch(/^No connected model can read images/);
    // A bot that turned the tool off is told that instead.
    const off = unavailableBuiltinToolReasons(
      { groupId: null, trigger: "user", disabledBuiltinTools: ["vision_analyze"] },
      [],
    );
    expect(off.vision_analyze).not.toMatch(/^No connected model/);
  });

  it("keeps them deferred, read-only and grouped with media", () => {
    for (const name of ["vision_analyze", "video_analyze"]) {
      expect(BUILTIN_AGENT_TOOL_NAMES.has(name)).toBe(true);
      expect(CORE_BUILTIN_TOOL_NAMES.has(name)).toBe(false);
      expect(READ_ONLY_AGENT_TOOLS.has(name)).toBe(true);
    }
    const { listed } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        imageUnderstandingAvailable: true,
        videoUnderstandingAvailable: true,
      }),
    );
    const index = listed.find((tool) => tool.name === FIND_TOOL)!.description;
    const media = index.match(/^media:\n {2}(.*)$/m)?.[1]?.split(", ");
    expect(media).toEqual(expect.arrayContaining(["vision_analyze", "video_analyze"]));
    expect(listed.some((tool) => tool.name === "vision_analyze")).toBe(false);
  });
});
