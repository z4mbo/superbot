import { describe, expect, it } from "vitest";
import type { LocalAccount, LocalAccountDirectory } from "./cloud-accounts.js";
import { mapCloudAccount } from "./cloud-accounts.js";

type Stored = LocalAccount & { usable?: boolean };

function directory(accounts: Stored[]): LocalAccountDirectory {
  const withUse = accounts.map((account) => ({ ...account, usable: account.usable ?? true }));
  return {
    byEmail: async (email) =>
      withUse.find((account) => account.email.toLowerCase() === email.toLowerCase()) ?? null,
    firstTwo: async () => withUse.slice(0, 2),
  };
}

const owner = { id: "user-owner", email: "owner@example.com", name: "Owner" };
const friend = { id: "user-friend", email: "Friend@Example.com", name: "Friend" };

describe("cloud account mapping", () => {
  it("signs a named entry in as the local account it names", async () => {
    const allowed = new Map([["cloud@example.com", "friend@example.com"]]);
    expect(await mapCloudAccount(allowed, directory([owner, friend]), "cloud@example.com")).toEqual(
      { ok: true, account: friend },
    );
  });

  it("signs a bare entry in as the local account with the same email", async () => {
    const allowed = new Map([["friend@example.com", null]]);
    expect(
      await mapCloudAccount(allowed, directory([owner, friend]), "friend@example.com"),
    ).toEqual({ ok: true, account: friend });
  });

  it("falls back to the only account on a single-account server", async () => {
    const allowed = new Map([["cloud@example.com", null]]);
    expect(await mapCloudAccount(allowed, directory([owner]), "cloud@example.com")).toEqual({
      ok: true,
      account: owner,
    });
  });

  it("refuses an account the operator did not list", async () => {
    const allowed = new Map([["owner@example.com", null]]);
    expect(await mapCloudAccount(allowed, directory([owner]), "stranger@example.com")).toEqual({
      ok: false,
      refusal: "account_not_allowed",
    });
  });

  it("refuses when no local account matches", async () => {
    const none = { ok: false, refusal: "no_local_account" };
    // Two accounts, neither with the email: no guess.
    expect(
      await mapCloudAccount(
        new Map([["cloud@example.com", null]]),
        directory([owner, friend]),
        "cloud@example.com",
      ),
    ).toEqual(none);
    // A named account never falls back to the single one.
    expect(
      await mapCloudAccount(
        new Map([["cloud@example.com", "missing@example.com"]]),
        directory([owner]),
        "cloud@example.com",
      ),
    ).toEqual(none);
    expect(
      await mapCloudAccount(
        new Map([["cloud@example.com", null]]),
        directory([]),
        "cloud@example.com",
      ),
    ).toEqual(none);
  });

  it("refuses a deactivated local account", async () => {
    expect(
      await mapCloudAccount(
        new Map([["owner@example.com", null]]),
        directory([{ ...owner, usable: false }]),
        "owner@example.com",
      ),
    ).toEqual({ ok: false, refusal: "no_local_account" });
  });
});
