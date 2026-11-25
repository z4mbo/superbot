import { describe, expect, it } from "vitest";
import { SERVER_UNREACHABLE, SuperbotError } from "./errors.js";

describe("SuperbotError.server", () => {
  it("prefers the RPC body's status, code and message", () => {
    const error = SuperbotError.server(500, {
      json: { status: 401, code: "UNAUTHORIZED", message: "Session expired" },
    });
    expect([error.kind, error.status, error.code]).toEqual(["server", 401, "UNAUTHORIZED"]);
    expect(error.message).toBe("Superbot returned HTTP 401: Session expired");
    expect(error.isUnauthorized()).toBe(true);
    expect(error.isRetryable()).toBe(false);
  });

  it("keeps the HTTP status when the body names none in range", () => {
    expect(SuperbotError.server(403, { json: { status: 200 } }).status).toBe(403);
    expect(SuperbotError.server(409, "not json").status).toBe(409);
  });

  it("reads a plain error body", () => {
    expect(SuperbotError.server(429, { error: "Slow down" }).message).toBe(
      "Superbot returned HTTP 429: Slow down",
    );
  });

  it("explains a refusal that has no message", () => {
    const messages = [401, 403, 404, 429, 400].map(
      (status) => SuperbotError.server(status, undefined).message,
    );
    expect(messages).toEqual([
      "Superbot returned HTTP 401: Session rejected. Sign in again.",
      "Superbot returned HTTP 403: Access denied.",
      "Superbot returned HTTP 404: The requested endpoint or chat was not found.",
      "Superbot returned HTTP 429: Too many requests. Try again later.",
      "Superbot returned HTTP 400: Request failed.",
    ]);
  });

  it("treats a gateway status as unavailable", () => {
    for (const payload of [undefined, { json: { status: 503 } }]) {
      const error = SuperbotError.server(payload ? 500 : 504, payload);
      expect(error.kind).toBe("unavailable");
      expect(error.message).toBe(SERVER_UNREACHABLE);
      expect(error.isRetryable()).toBe(true);
    }
  });
});

describe("SuperbotError", () => {
  it("counts a missing session as unauthorized", () => {
    expect(SuperbotError.missingSession().isUnauthorized()).toBe(true);
    expect(SuperbotError.invalidSession().isUnauthorized()).toBe(false);
  });

  it("names a transport failure by its cause", () => {
    const error = SuperbotError.transport(
      new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
    );
    expect(error.message).toBe("Could not reach Superbot: connect ECONNREFUSED");
    expect(error.isRetryable()).toBe(true);
  });
});
