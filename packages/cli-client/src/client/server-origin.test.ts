import { describe, expect, it } from "vitest";
import { SuperbotError } from "../errors.js";
import { serverOrigin } from "./server-origin.js";

describe("serverOrigin", () => {
  it("normalizes an HTTPS origin", () => {
    expect(serverOrigin("https://Example.test:443")).toEqual({
      origin: "https://example.test/",
      loopback: false,
    });
    expect(serverOrigin("https://example.test/").origin).toBe("https://example.test/");
  });

  it("allows plain HTTP only on this computer", () => {
    for (const local of ["http://127.0.0.1:5173", "http://localhost:3000", "http://[::1]:8080"]) {
      expect(serverOrigin(local).loopback).toBe(true);
    }
    expect(serverOrigin("https://127.0.0.1").loopback).toBe(true);
  });

  it("refuses anything but an origin", () => {
    for (const server of [
      "http://example.test",
      "http://10.0.0.2",
      "https://example.test/path",
      "https://user@example.test",
      "https://:secret@example.test",
      "https://example.test/?",
      "https://example.test/?token=x",
      "https://example.test/#",
      "ftp://example.test",
      "example.test",
      "",
    ]) {
      expect(() => serverOrigin(server), server).toThrow(SuperbotError);
    }
  });
});
