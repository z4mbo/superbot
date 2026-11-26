export const DOCS_PATH = "/docs/";

type DocsPage = {
  /** The page lives at `/docs/<slug>/`; the first page of the first section is `/docs/`. */
  slug: string;
  label: string;
  /** The page's source, `docs/<file>.md`, when it differs from the slug. */
  file?: string;
};

type DocsSection = { title: string; pages: readonly DocsPage[] };

export const BUILD_AN_APP_SLUG = "build-an-app";

export const DOCS_NAV = [
  {
    title: "Get started",
    pages: [
      { slug: "getting-started", label: "Getting started" },
      { slug: "troubleshooting", label: "Troubleshooting" },
      { slug: "bots-and-chats", label: "Bots and chats" },
      { slug: "import-an-agent", label: "Import an agent" },
    ],
  },
  {
    title: "Apps platform",
    pages: [
      { slug: BUILD_AN_APP_SLUG, label: "Build an app", file: "plugin-sdk" },
      {
        slug: "publish-an-app",
        label: "Publish to the Store",
        file: "superbot/build-a-marketplace-plugin",
      },
      { slug: "app-toolkit", label: "Command-line toolkit", file: "superbot/plugin-toolkit" },
      { slug: "app-registry-api", label: "Registry API", file: "superbot/plugin-contract" },
      { slug: "app-runtime", label: "How installed apps run", file: "superbot/plugin-runtime" },
      { slug: "import-from-github", label: "Import from GitHub", file: "build-a-plugin" },
    ],
  },
  {
    title: "Using Superbot",
    pages: [
      { slug: "integrations", label: "Connections" },
      { slug: "routines", label: "Routines" },
      { slug: "pages", label: "Pages" },
      { slug: "computer", label: "The bot's computer" },
      { slug: "memory", label: "Memory" },
      { slug: "skills", label: "Skills" },
      { slug: "approvals", label: "Approvals" },
      { slug: "groups", label: "Groups and teamwork" },
      { slug: "voice-and-calls", label: "Voice and calls" },
      { slug: "meetings", label: "Meetings" },
      { slug: "messaging-apps", label: "Chat apps" },
    ],
  },
  {
    title: "Settings",
    pages: [
      { slug: "models", label: "Models" },
      { slug: "model-subscriptions", label: "Model subscriptions" },
      { slug: "spaces", label: "Spaces" },
      { slug: "bot-secrets", label: "Reusable credentials" },
      { slug: "account", label: "Account and billing" },
    ],
  },
  {
    title: "Desktop and mobile",
    pages: [
      { slug: "desktop-app", label: "Desktop app" },
      { slug: "mobile-app", label: "Mobile app" },
    ],
  },
  {
    title: "Advanced",
    pages: [
      { slug: "fleet-management", label: "Bots that manage bots" },
      { slug: "board", label: "Ticket board" },
    ],
  },
  {
    title: "Self-hosting",
    pages: [
      { slug: "self-host", label: "Overview" },
      { slug: "self-host-configuration", label: "Configuration" },
      { slug: "self-host-secrets", label: "Secrets" },
      { slug: "self-host-production", label: "Production deployment" },
      { slug: "self-host-upgrading", label: "Upgrading" },
      { slug: "self-host-backups", label: "Backup and restore" },
    ],
  },
  {
    title: "Configure your server",
    pages: [
      { slug: "self-host-accounts", label: "Sign-in and accounts" },
      { slug: "self-host-models", label: "Models" },
      { slug: "self-host-integrations", label: "Tools and integrations" },
      { slug: "self-host-inbound-email", label: "Bot email addresses" },
      { slug: "self-host-meetings", label: "Meeting bots" },
      { slug: "self-host-sandbox-providers", label: "Computer providers" },
      { slug: "self-host-docker-computers", label: "Docker computers" },
      { slug: "computer-runtime", label: "Computer runtime" },
      { slug: "self-host-storage", label: "Storage and encryption" },
      { slug: "self-host-clients", label: "Apps and clients" },
      { slug: "self-host-billing", label: "Billing" },
      { slug: "self-host-observability", label: "Logs and monitoring" },
      { slug: "self-host-audit-log", label: "Audit log" },
      { slug: "self-host-restricted-network", label: "Restricted networks" },
    ],
  },
] as const satisfies readonly DocsSection[];

export const DOCS_PAGES: { slug: string; label: string; file: string; section: string }[] =
  DOCS_NAV.flatMap((section) =>
    section.pages.map((page: DocsPage) => ({
      ...page,
      file: page.file ?? page.slug,
      section: section.title,
    })),
  );

export const DOCS_SLUGS = DOCS_PAGES.map((page) => page.slug);

/** Old docs slugs and the page each one moved to. vercel.json redirects every one (a build check holds this). */
export const DOCS_REDIRECTS: Readonly<Record<string, string>> = {
  "plugin-sdk": BUILD_AN_APP_SLUG,
  "build-a-plugin": "import-from-github",
};

export function docsPath(slug: string): string {
  return slug === DOCS_SLUGS[0] ? DOCS_PATH : `${DOCS_PATH}${slug}/`;
}

export const BUILD_AN_APP_PATH = docsPath(BUILD_AN_APP_SLUG);
/** The Build an app prompt as plain text, for agents and for copying without JavaScript. */
export const BUILD_APP_PROMPT_PATH = `${BUILD_AN_APP_PATH}prompt.txt`;

/** The published page whose source is `docs/<file>.md`, if any. */
export function docsSlugForFile(file: string): string | undefined {
  return DOCS_PAGES.find((page) => page.file === file)?.slug;
}
