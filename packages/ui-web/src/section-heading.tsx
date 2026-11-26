import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./lib/utils.js";

// Labels sit at regular weight, as the reference sets its group labels.
const sectionHeadingVariants = cva("", {
  variants: {
    variant: {
      heading: "text-heading3 font-medium text-foreground",
      title: "text-body-lg font-medium text-foreground",
      panel: "text-body-sm text-muted-foreground",
      label: "text-label text-muted-foreground",
    },
  },
  defaultVariants: { variant: "title" },
});

/**
 * Names a section within a page or panel; `heading` is the larger tier for settings sections,
 * `panel` the quieter tier for side-panel and sidebar groups (13/18, as the reference sets them)
 * and `label` the smallest, for groups inside settings.
 */
function SectionHeading({
  as: Tag = "h3",
  variant,
  className,
  ...props
}: ComponentProps<"h3"> &
  VariantProps<typeof sectionHeadingVariants> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag
      data-slot="section-heading"
      className={cn(sectionHeadingVariants({ variant }), className)}
      {...props}
    />
  );
}

export { SectionHeading };
