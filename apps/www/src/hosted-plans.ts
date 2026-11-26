/**
 * Hosted plans shown on the home page. Display only: none can be bought yet, so the page offers
 * no checkout, sign-up or trial for them. Self-hosting is free and available now.
 *
 * Prices researched 25 Nov 2026 against comparable hosted agent products; provisional until
 * hosted plans launch.
 */
export type HostedPlan = {
  id: "self-hosted" | "starter" | "pro" | "max" | "team" | "enterprise";
  name: string;
  /** Monthly price in US dollars; null for a plan without a list price. */
  monthlyUsd: number | null;
  /** Shown in place of a price when there is none. */
  priceLabel?: string;
  /** One short line under the price. */
  detail?: string;
  /** Available now; every other plan is shown as coming soon. */
  available: boolean;
  popular?: boolean;
};

export const HOSTED_PLANS: readonly HostedPlan[] = [
  {
    id: "self-hosted",
    name: "Self-hosted",
    monthlyUsd: 0,
    priceLabel: "Free",
    detail: "Run it on your own machine or server.",
    available: true,
  },
  { id: "starter", name: "Starter", monthlyUsd: 15, available: false },
  { id: "pro", name: "Pro", monthlyUsd: 49, available: false, popular: true },
  { id: "max", name: "Max", monthlyUsd: 99, available: false },
  {
    id: "team",
    name: "Team",
    monthlyUsd: 40,
    detail: "For 2 people, +$20 per extra seat.",
    available: false,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: null,
    priceLabel: "Contact",
    available: false,
  },
];

/** "$15/mo", "Free" or "Contact". */
export function planPrice(plan: HostedPlan): string {
  if (plan.priceLabel) return plan.priceLabel;
  if (plan.monthlyUsd === null) throw new Error(`Plan ${plan.id} needs a price or a label`);
  return `$${plan.monthlyUsd}/mo`;
}
