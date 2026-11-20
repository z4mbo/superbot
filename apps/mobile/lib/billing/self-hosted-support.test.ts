import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Guard the two mobile entry points when the fork next merges upstream.
it.each(["index.tsx", "(settings)/account.tsx"])(
  "%s omits the upstream self-hosted support offer",
  (route) => {
    const source = readFileSync(new URL(`../../app/${route}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/self-hosted-support|selfHostedSupport|Support Rakazo/i);
  },
);
