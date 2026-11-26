import { readFileSync } from "node:fs";
import {
  APP_ACTION_MESSAGE,
  APP_ANSWER_MESSAGE,
  APP_QUERY_KEY_MAX_LENGTH,
  APP_QUERY_MESSAGE,
  APP_REFETCH_MESSAGE,
  APP_RESULT_MESSAGE,
  APP_STATE_MESSAGE,
  APP_UNQUERY_MESSAGE,
} from "@rakazo/plugin-sdk/bridge";
import { expect, it } from "vitest";

// The shell sits between an app's document and the bridge and passes only the messages it names,
// so a message the bridge speaks but the shell does not name never arrives.
const shell = readFileSync(new URL("../../../public/html-viewer.html", import.meta.url), "utf8");

it("the viewer shell passes every message the app bridge speaks", () => {
  for (const type of [
    APP_ACTION_MESSAGE,
    APP_RESULT_MESSAGE,
    APP_STATE_MESSAGE,
    APP_QUERY_MESSAGE,
    APP_UNQUERY_MESSAGE,
    APP_REFETCH_MESSAGE,
    APP_ANSWER_MESSAGE,
  ])
    expect(shell, type).toContain(`"${type}"`);
});

it("the viewer shell hands an action's result and a query's answer down whole", () => {
  expect(shell).toContain("result: event.data.result");
  expect(shell).toContain("data: event.data.data");
});

it("the viewer shell takes query keys as long as the bridge does", () => {
  expect(shell).toContain(`const QUERY_KEY_MAX = ${APP_QUERY_KEY_MAX_LENGTH};`);
});
