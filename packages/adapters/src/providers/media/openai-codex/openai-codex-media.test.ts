import { describe, expect, it } from "vitest";
import {
  mediaContext as context,
  inputPng,
  json,
  mediaFetch,
  PNG,
  pngBase64,
  pngDataUrl,
} from "../../../media/media-provider.test-support.js";
import { chatgptAccountId, openaiCodexMedia } from "./openai-codex-media.js";

const signIn = {
  kind: "model_connection",
  provider: "openai-codex",
  auth: "oauth",
  token: "access-token",
  accountId: "account-1",
} as const;
const result = { created: 1, data: [{ b64_json: pngBase64, generation_id: "g" }] };
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: openaiCodexMedia.create(signIn, mocked.http) };
}

describe("ChatGPT sign-in images", () => {
  it("generates through the Codex image endpoint with the sign-in's headers", async () => {
    const { provider, call } = build(json(result));
    expect(
      await provider.generateImage(
        { prompt: "draw", aspectRatio: "9:16", quality: "auto" },
        context,
      ),
    ).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(call(0).url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(call(0).headers.get("authorization")).toBe("Bearer access-token");
    expect(call(0).headers.get("chatgpt-account-id")).toBe("account-1");
    expect(call(0).headers.get("originator")).toBe("rakazo");
    expect(call(0).headers.get("x-codex-image-turn-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(call(0).json()).toEqual({
      prompt: "draw",
      model: "gpt-image-2",
      n: 1,
      size: "1024x1536",
    });
  });

  it("edits with the source image and references", async () => {
    const { provider, call } = build(json(result));
    await provider.editImage?.(
      { prompt: "add a hat", image: inputPng, referenceImages: [inputPng] },
      context,
    );
    expect(call(0).url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(call(0).json()).toMatchObject({
      images: [{ image_url: pngDataUrl }, { image_url: pngDataUrl }],
    });
  });

  it("refuses a mask, a sixth image, other models and video", async () => {
    const { provider, fetch } = build();
    await expect(
      provider.editImage?.({ prompt: "x", image: inputPng, mask: inputPng }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.editImage?.(
        { prompt: "x", image: inputPng, referenceImages: Array(5).fill(inputPng) },
        context,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.generateImage({ prompt: "x", model: "gpt-image-2.5-flare" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.generateVideo({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(provider.capabilities.video).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, { error: { code: "moderation_blocked", message: "private" } }, "content_policy"],
    [400, { error: { code: "content_policy_violation" } }, "content_policy"],
    [400, { error: { code: "invalid_value" } }, "provider_failure"],
    [401, { error: { code: "token_expired" } }, "authentication"],
    [429, { error: { type: "usage_limit_reached", plan_type: "plus" } }, "rate_limit"],
  ])("maps HTTP %i %j", async (status, body, code) => {
    const { provider } = build(json(body, { status }));
    const error = await provider.generateImage({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });

  it("reads the account from the access token when the sign-in does not name it", () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "from-token" } }),
    ).toString("base64url");
    expect(chatgptAccountId(`h.${payload}.s`)).toBe("from-token");
    expect(chatgptAccountId("not-a-jwt")).toBeUndefined();
    expect(() =>
      openaiCodexMedia.create({ ...signIn, accountId: undefined, token: "not-a-jwt" }, {}),
    ).toThrow("authentication");
  });

  it("borrows only the ChatGPT sign-in", () => {
    expect(() => openaiCodexMedia.create({ kind: "key", fields: { apiKey: "k" } }, {})).toThrow(
      "authentication",
    );
    expect(() =>
      openaiCodexMedia.create({ ...signIn, provider: "openai", auth: "api_key" }, {}),
    ).toThrow("authentication");
  });
});
