import { BUILD_APP_PROMPT } from "@rakazo/plugin-sdk/guide";
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ request }) =>
  new Response(request.method === "HEAD" ? null : `${BUILD_APP_PROMPT}\n`, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
