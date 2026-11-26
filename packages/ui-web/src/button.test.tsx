import { describe, expect, it } from "vitest";
import { buttonVariants } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

describe("buttonVariants", () => {
  it.each(["default", "sm", "xs", "icon-sm", "icon-lg"] as const)(
    "keeps floating buttons a pill at size %s",
    (size) => {
      // Button merges its classes with cn, so later radius classes win.
      const classes = cn(buttonVariants({ variant: "floating", size })).split(" ");
      expect(classes).toContain("rounded-full");
      expect(classes.filter((name) => /^rounded-(?!full$)/.test(name))).toEqual([]);
    },
  );
});

describe("focus ring", () => {
  it.each(["default", "outline", "ghost", "floating", "destructive"] as const)(
    "rings a %s button with a solid 2px ring a pixel outside it, as the reference does",
    (variant) => {
      const classes = cn(buttonVariants({ variant })).split(" ");
      expect(classes).toEqual(
        expect.arrayContaining([
          "focus-visible:ring-2",
          "focus-visible:ring-ring",
          "focus-visible:ring-offset-1",
        ]),
      );
      // No translucent or tinted ring, and no border that would thicken it.
      expect(
        classes.filter((name) =>
          /^(dark:)?focus-visible:(ring-(3|\[3px\])|ring-\S+\/\d+|border-)/.test(name),
        ),
      ).toEqual([]);
    },
  );
});
