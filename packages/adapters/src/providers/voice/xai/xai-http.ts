import { voiceErrorDetail, voiceRequestError } from "../../../voice/voice-http.js";

export const XAI_API = "https://api.x.ai/v1";
export const XAI_PROVIDER_NAME = "xAI";

/** Normalize xAI's account statuses only at its adapter boundary. */
export function xaiRequestError(status: number, what: string, body: unknown): Error {
  const message = voiceErrorDetail(body);
  if (status === 400 && /\b(?:incorrect|invalid) api key\b/i.test(message)) status = 401;
  if (
    status === 403 &&
    /\bcredits?\b|billing|paid subscription|account is not active/i.test(message)
  )
    status = 402;
  return voiceRequestError(status, XAI_PROVIDER_NAME, what, body);
}
