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
import { imageFromResponseStream, openaiCodexMedia } from "./openai-codex-media.js";

const signIn = {
  kind: "model_connection",
  provider: "openai-codex",
  auth: "oauth",
  token: "access-token",
  accountId: "account-1",
} as const;

/** A recorded-shape event stream: the call is announced, then finished with its image. */
function stream(...events: unknown[]) {
  return new Response(
    events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const finished = () =>
  stream(
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", item: { type: "image_generation_call", id: "ig_1" } },
    {
      type: "response.output_item.done",
      item: { type: "image_generation_call", id: "ig_1", status: "completed", result: pngBase64 },
    },
    { type: "response.completed", response: { id: "resp_1" } },
  );
function build(...responses: Response[]) {
  const mocked = mediaFetch(...responses);
  return { ...mocked, provider: openaiCodexMedia.create(signIn, mocked.http) };
}

describe("ChatGPT sign-in images", () => {
  it("generates through the Codex responses endpoint with the image tool", async () => {
    const { provider, call } = build(finished());
    expect(
      await provider.generateImage(
        { prompt: "draw", aspectRatio: "9:16", quality: "auto" },
        context,
      ),
    ).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(call(0).url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call(0).method).toBe("POST");
    expect(call(0).headers.get("authorization")).toBe("Bearer access-token");
    expect(call(0).headers.get("chatgpt-account-id")).toBe("account-1");
    expect(call(0).headers.get("accept")).toBe("text/event-stream");
    expect(call(0).headers.get("originator")).toBe("rakazo");
    const body = call(0).json();
    expect(body).toMatchObject({
      store: false,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "draw" }] }],
      tools: [
        {
          type: "image_generation",
          model: "gpt-image-2.5-sunburst",
          action: "generate",
          size: "1024x1536",
        },
      ],
      tool_choice: { type: "image_generation" },
    });
    expect(typeof body.model).toBe("string");
  });

  it("takes each listed image model", async () => {
    for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
      const { provider, call } = build(finished());
      await provider.generateImage({ prompt: "draw", model }, context);
      expect(call(0).json()).toMatchObject({ tools: [{ model }] });
    }
  });

  it("edits with the source image and references", async () => {
    const { provider, call } = build(finished());
    await provider.editImage?.(
      { prompt: "add a hat", image: inputPng, referenceImages: [inputPng] },
      context,
    );
    expect(call(0).json()).toMatchObject({
      input: [
        {
          content: [
            { type: "input_text", text: "add a hat" },
            { type: "input_image", image_url: pngDataUrl },
            { type: "input_image", image_url: pngDataUrl },
          ],
        },
      ],
      tools: [{ action: "edit" }],
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
      provider.generateImage({ prompt: "x", model: "gpt-image-1" }, context),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.generateVideo({ prompt: "x" }, context)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(provider.capabilities.video).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, { error: { code: "moderation_blocked", message: "private" } }, "content_policy"],
    [400, { error: { code: "invalid_value" } }, "provider_failure"],
    [401, { error: { code: "token_expired" } }, "authentication"],
    [429, { error: { type: "usage_limit_reached", plan_type: "plus" } }, "rate_limit"],
  ])("maps HTTP %i %j", async (status, body, code) => {
    const { provider } = build(json(body, { status }));
    const error = await provider.generateImage({ prompt: "x" }, context).catch((e) => e);
    expect(error).toMatchObject({ code, message: `Media generation: ${code}` });
  });

  it("reads failures and missing images from the stream", () => {
    const text = async (response: Response) => response.text();
    return Promise.all([
      text(
        stream({ type: "response.failed", response: { error: { code: "moderation_blocked" } } }),
      ).then((body) =>
        expect(() => imageFromResponseStream(body)).toThrow("Media generation: content_policy"),
      ),
      text(stream({ type: "response.completed", response: {} })).then((body) =>
        expect(() => imageFromResponseStream(body)).toThrow("Media generation: provider_failure"),
      ),
      text(stream({ type: "error", error: { code: "server_error" } })).then((body) =>
        expect(() => imageFromResponseStream(body)).toThrow("Media generation: provider_failure"),
      ),
    ]);
  });

  it("borrows only a ChatGPT sign-in that names its account", () => {
    expect(() => openaiCodexMedia.create({ kind: "key", fields: { apiKey: "k" } }, {})).toThrow(
      "authentication",
    );
    expect(() =>
      openaiCodexMedia.create({ ...signIn, provider: "openai", auth: "api_key" }, {}),
    ).toThrow("authentication");
    expect(() => openaiCodexMedia.create({ ...signIn, accountId: undefined }, {})).toThrow(
      "authentication",
    );
  });
});
