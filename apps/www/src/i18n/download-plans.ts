/**
 * Copy for the home page's Download and Pricing sections. English only for now: other locales
 * show it in English (the sections are marked `lang="en"` there) until translations are added.
 */
export const DOWNLOAD_COPY = {
  heading: "Download Superbot",
  desktop: "Desktop",
  terminal: "Terminal",
  platforms: { windows: "Windows", mac: "macOS", linux: "Linux" },
  linuxDeb: "Linux (.deb)",
  allReleases: "All releases",
  buildFromSource: "Build from source",
  selfHostGuide: "Self-host guide",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
} as const;

export const PLANS_COPY = {
  heading: "Pricing",
  copy: "Self-hosting is free. Hosted plans are coming soon.",
  comingSoon: "Coming soon",
  popular: "Popular",
  selfHostGuide: "Self-host guide",
  footnote: "Hosted plans and prices are provisional.",
} as const;
