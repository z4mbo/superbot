import type { ConnectorTool } from "@rakazo/adapter-kit";

export const MEDIA_TOOL_NAMES = ["generate_image", "edit_image", "generate_video"] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

const IMAGE_SOURCE =
  '"attached" for the image the user attached to this message, an artifactId of an image in this conversation, or a workspace file path.';

const prompt = { type: "string", minLength: 1, maxLength: 4000 };
const choice = {
  provider: {
    type: "string",
    maxLength: 80,
    description: "A provider id from the list below; omit to use the user's default.",
  },
  model: {
    type: "string",
    maxLength: 200,
    description: "A model id from the list below; omit for the provider's default.",
  },
};
const imageShape = {
  aspectRatio: { type: "string", maxLength: 20, description: 'Width to height, such as "16:9".' },
  size: { type: "string", maxLength: 20, description: 'Pixels, such as "1024x1024".' },
  quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
  referenceImages: {
    type: "array",
    maxItems: 8,
    items: { type: "string", maxLength: 1000 },
    description: `Images that steer the result, each ${IMAGE_SOURCE}`,
  },
};

/** Media tools. Each run appends what the user connected (see `withMediaChoices`). */
export const mediaTools: ConnectorTool[] = [
  {
    name: "generate_image",
    description:
      "Generate one image from a prompt and attach it to chat. May incur charges on the user's provider. Do not retry failed submissions automatically.",
    inputSchema: {
      type: "object",
      properties: { prompt, ...choice, ...imageShape },
      required: ["prompt"],
    },
    readOnly: false,
  },
  {
    name: "edit_image",
    description:
      "Change an existing image as the prompt says and attach the result to chat. May incur charges on the user's provider. Do not retry failed submissions automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt,
        image: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: `The image to change: ${IMAGE_SOURCE}`,
        },
        mask: {
          type: "string",
          maxLength: 1000,
          description: `Marks the part to change, where the model takes a mask: ${IMAGE_SOURCE}`,
        },
        ...choice,
        ...imageShape,
      },
      required: ["prompt", "image"],
    },
    readOnly: false,
  },
  {
    name: "generate_video",
    description:
      "Submit a short video from a prompt (may incur charges on the user's provider). It is attached to the chat when ready, without polling; pass jobId only to check progress. Do not resubmit failed or uncertain jobs automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt,
        jobId: { type: "string", minLength: 1, maxLength: 200 },
        ...choice,
        startFrame: {
          type: "string",
          maxLength: 1000,
          description: `First frame: ${IMAGE_SOURCE}`,
        },
        endFrame: { type: "string", maxLength: 1000, description: `Last frame: ${IMAGE_SOURCE}` },
        durationSeconds: { type: "number", minimum: 1, maximum: 60 },
        resolution: { type: "string", maxLength: 20, description: 'Such as "720p".' },
        aspectRatio: imageShape.aspectRatio,
        audio: { type: "boolean", description: "Whether the video has generated sound." },
      },
    },
    readOnly: false,
  },
];

/** The tool as this run offers it: its description names the providers and models it may pass. */
export function withMediaChoices(tool: ConnectorTool, choices: string): ConnectorTool {
  return choices ? { ...tool, description: `${tool.description} Available: ${choices}.` } : tool;
}
