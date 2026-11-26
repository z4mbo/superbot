import { describe, expect, it } from "vitest";
import { HOSTED_PLANS, planPrice } from "./hosted-plans";

describe("HOSTED_PLANS", () => {
  it("lists the agreed grid", () => {
    expect(HOSTED_PLANS.map((plan) => [plan.name, planPrice(plan)])).toEqual([
      ["Self-hosted", "Free"],
      ["Starter", "$15/mo"],
      ["Pro", "$49/mo"],
      ["Max", "$99/mo"],
      ["Team", "$40/mo"],
      ["Enterprise", "Contact"],
    ]);
  });

  it("offers only self-hosting today and marks Pro popular", () => {
    expect(HOSTED_PLANS.filter((plan) => plan.available).map((plan) => plan.id)).toEqual([
      "self-hosted",
    ]);
    expect(HOSTED_PLANS.filter((plan) => plan.popular).map((plan) => plan.id)).toEqual(["pro"]);
  });
});
