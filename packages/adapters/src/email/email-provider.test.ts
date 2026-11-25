import { describe, expect, it } from "vitest";
import { configuredBotEmailProvider, configuredEmailProvider } from "./email-provider.js";

describe("account email connection", () => {
  it("is off without a provider, so invitations report it is not set up", () => {
    expect(configuredEmailProvider({})).toBeUndefined();
    expect(configuredEmailProvider({ provider: "none", apiKey: "key", from: "a@b.test" })).toBe(
      undefined,
    );
  });

  // The server refuses to start rather than run with a provider whose every send would fail.
  it.each([
    [{ provider: "resend", from: "Rakazo <hi@example.test>" }, "EMAIL_API_KEY"],
    [{ provider: "resend", apiKey: "  ", from: "Rakazo <hi@example.test>" }, "EMAIL_API_KEY"],
    [{ provider: "resend", apiKey: "key" }, "EMAIL_FROM"],
    [{ provider: "resend", apiKey: "key", from: " " }, "EMAIL_FROM"],
    [{ provider: "smtp", from: "Rakazo <hi@example.test>" }, "SMTP_URL"],
    [{ provider: "smtp", smtpUrl: "  ", from: "Rakazo <hi@example.test>" }, "SMTP_URL"],
    [{ smtpUrl: "smtps://smtp.example.test" }, "EMAIL_FROM"],
    [{ smtpUrl: "smtps://smtp.example.test", from: "  " }, "EMAIL_FROM"],
  ])("refuses a connection that cannot send: %j", (config, missing) => {
    expect(() => configuredEmailProvider(config)).toThrow(missing);
  });

  it("connects when every required setting is present", async () => {
    const http = configuredEmailProvider({
      provider: "resend",
      apiKey: "key",
      from: "Rakazo <hi@example.test>",
    });
    expect(http?.describe().id).toBe("resend");
    const smtp = configuredEmailProvider({
      smtpUrl: "smtps://smtp.example.test",
      from: "Rakazo <hi@example.test>",
    });
    expect(smtp?.describe().id).toBe("smtp");
    await smtp?.drain?.();
  });
});

describe("bot email connection", () => {
  it("is disabled without its own connection and requires an address domain", async () => {
    expect(configuredBotEmailProvider({ domain: "bots.example.test" })).toBeUndefined();
    expect(() => configuredBotEmailProvider({ smtpUrl: "smtps://smtp.example.test" })).toThrow(
      "INBOUND_EMAIL_DOMAIN",
    );
    const email = configuredBotEmailProvider({
      smtpUrl: "smtps://smtp.example.test",
      domain: "bots.example.test",
    });
    expect(email?.describe().id).toBe("smtp");
    await email?.drain?.();
  });
});
