import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

// The reference's inks, in its editor's order: neutral is black on light and white on dark.
const INKS = {
  light: {
    neutral: "rgb(0, 0, 0)",
    brown: "rgb(160, 107, 57)",
    red: "rgb(251, 43, 62)",
    orange: "rgb(253, 105, 15)",
    yellow: "rgb(245, 147, 18)",
    green: "rgb(20, 193, 111)",
    cyan: "rgb(19, 183, 162)",
    blue: "rgb(30, 134, 252)",
    purple: "rgb(143, 89, 249)",
    magenta: "rgb(249, 52, 152)",
    gray: "rgb(149, 149, 149)",
  },
  dark: {
    neutral: "rgb(255, 255, 255)",
    brown: "rgb(161, 107, 57)",
    red: "rgb(252, 44, 62)",
    orange: "rgb(249, 103, 14)",
    yellow: "rgb(246, 148, 18)",
    green: "rgb(20, 195, 112)",
    cyan: "rgb(19, 184, 163)",
    blue: "rgb(24, 132, 252)",
    purple: "rgb(144, 90, 251)",
    magenta: "rgb(251, 52, 153)",
    gray: "rgb(119, 119, 119)",
  },
} as const;

for (const theme of ["light", "dark"] as const) {
  test(`marks are one flat ink with nothing drawn around them in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/e2e/fixtures/bot-mark-gallery.html?theme=${theme}`);
    const inks = page.getByTestId("inks").locator("svg[data-bot-mark-ink]");
    await expect(inks).toHaveCount(Object.keys(INKS[theme]).length);
    const drawn = await inks.evaluateAll((marks) =>
      marks.map((mark) => [mark.getAttribute("data-bot-mark-ink"), getComputedStyle(mark).color]),
    );
    expect(Object.fromEntries(drawn)).toEqual(INKS[theme]);

    // No shadow, filter, ring or plate on a mark or anything it sits in, groups included.
    const chrome = await page.locator("svg[data-bot-mark]").evaluateAll((marks) =>
      marks.flatMap((mark) => {
        const found: string[] = [];
        for (
          let node: Element | null = mark;
          node && node.id !== "root";
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (style.filter !== "none") found.push(`filter ${style.filter}`);
          if (style.boxShadow !== "none") found.push(`shadow ${style.boxShadow}`);
          if (style.backgroundImage !== "none" && !style.backgroundImage.startsWith('url("data'))
            found.push(`background ${style.backgroundImage}`);
          if (node !== mark && style.backgroundColor !== "rgba(0, 0, 0, 0)")
            found.push(`plate ${style.backgroundColor}`);
          if (style.borderStyle !== "none" && style.borderWidth !== "0px")
            found.push(`border ${style.borderWidth}`);
        }
        return found;
      }),
    );
    expect(chrome).toEqual([]);

    // A still picture draws the pumpkin's stem like the live mark.
    const pumpkin = page.getByTestId("stills").locator('svg[data-bot-mark="pumpkin"]');
    await expect(pumpkin.locator('path[fill^="var(--bot-stem"]')).toHaveCount(2);

    // Each group member is cut where a later one overlaps it; the last is whole.
    const pair = page.getByTestId("groups").locator(".rakazo-group-avatar").first();
    const masks = await pair
      .locator(":scope > div")
      .evaluateAll((members) => members.map((member) => getComputedStyle(member).maskImage));
    expect(masks[0]).toContain("data:image/svg+xml");
    expect(masks.at(-1)).toBe("none");
    await captureScreenshot(page, testInfo, `bot-mark-look-${theme}`);
  });
}
