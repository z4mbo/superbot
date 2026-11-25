/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
  /** `"1"` builds the hosted site; see `src/cloud/cloud-mode.ts`. */
  readonly VITE_SUPERBOT_CLOUD?: string;
  /** The hosted site's account service key; public by design. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** Build id (`YYYYMMDDHHMMSS`) of a production build; empty on the dev server. */
  readonly RAKAZO_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.po" {
  export const messages: Record<string, unknown>;
}
