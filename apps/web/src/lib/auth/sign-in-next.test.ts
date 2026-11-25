import { expect, it } from "vitest";
import { newAccountDestination, signInNext } from "./sign-in-next.js";

it("returns to integration setup, app review, MCP sign-in and invite links only", () => {
  expect(signInNext("/integrations/setup")).toBe("/integrations/setup");
  expect(signInNext("/admin/apps")).toBe("/admin/apps");
  expect(signInNext("/admin/plugins")).toBe("/admin/plugins");
  expect(signInNext("/onboarding/model")).toBe("/onboarding/model");
  expect(signInNext("/onboarding/model/../../app")).toBeNull();
  expect(signInNext("/mcp/oauth/callback?code=c&state=s")).toBe(
    "/mcp/oauth/callback?code=c&state=s",
  );
  expect(signInNext("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(signInNext("/join/0b8f3c1e-7a2d-4e6b-9c1f-2d3e4f5a6b7c")).toBe(
    "/join/0b8f3c1e-7a2d-4e6b-9c1f-2d3e4f5a6b7c",
  );
  expect(signInNext("/join/abc/../../app")).toBeNull();
  expect(signInNext(null)).toBeNull();
  expect(signInNext("/app")).toBeNull();
  expect(signInNext("/app/bot-1?threadId=conversation-2&m=message-3")).toBe(
    "/app/bot-1?threadId=conversation-2&m=message-3",
  );
  expect(signInNext("//example.com/app/bot-1?threadId=conversation-2")).toBeNull();
  expect(signInNext("https://example.com/invite/abc")).toBeNull();
  expect(signInNext("//example.com/invite/abc")).toBeNull();
  expect(signInNext("/invite/abc/../../app")).toBeNull();
  expect(signInNext("/invite/")).toBeNull();
});

it("starts a new account in onboarding unless it came for an invite or invitation", () => {
  expect(newAccountDestination("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(newAccountDestination("/join/abc_DEF-123")).toBe("/join/abc_DEF-123");
  expect(newAccountDestination("/integrations/setup")).toBe("/workspaces");
  expect(newAccountDestination(null)).toBe("/workspaces");
});
