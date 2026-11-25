import type { ConnectorTool } from "@rakazo/adapter-kit";

/** One image or video, from exactly one source, and what to look for in it. */
function mediaAnalysisSchema(kind: "image" | "video"): ConnectorTool["inputSchema"] {
  return {
    type: "object",
    properties: {
      path: { type: "string", description: `Path of the ${kind} in the workspace.` },
      attachment: {
        type: "string",
        description: "An attachment from this conversation: its attachments/ path or id.",
      },
      url: { type: "string", description: `A public https URL of the ${kind}.` },
      question: {
        type: "string",
        maxLength: 2000,
        description: "What to find out or focus on. Leave out for a general description.",
      },
    },
  };
}

/** Image and video understanding with a connected model; distinct from the generation tools. */
export const mediaUnderstandingTools: ConnectorTool[] = [
  {
    name: "vision_analyze",
    description:
      "Have a connected vision model describe one image and answer a question about it: contents, details and visible text. Use it for an image in the workspace, at a URL, or attached when you cannot see images yourself; an image already visible in your input needs no call. Give exactly one of path, attachment or url. Returns text only.",
    inputSchema: mediaAnalysisSchema("image"),
    readOnly: true,
  },
  {
    name: "video_analyze",
    description:
      "Have a connected model that reads video describe one video and answer a question about it: what happens, visible text and, when it hears audio, a transcript. Give exactly one of path, attachment or url. Returns text only.",
    inputSchema: mediaAnalysisSchema("video"),
    readOnly: true,
  },
];
