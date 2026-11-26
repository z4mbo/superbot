import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { messages } from "@rakazo/i18n/locales/en/messages.po";
import { createRoot } from "react-dom/client";
import { WindowChrome } from "../../src/components/WindowChrome";
import { WindowControls } from "../../src/components/WindowControls";
import "../../src/styles.css";

const i18n = setupI18n({
  locale: "en",
  messages: { en: messages } as NonNullable<Parameters<typeof setupI18n>[0]>["messages"],
});
// Dark unless the page asks for light, as the screenshots of each theme do.
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <div className="flex h-screen">
      <aside className="w-64 bg-sidebar p-3">
        <WindowChrome />
        <p className="mt-4">Window controls preview</p>
      </aside>
      <WindowControls />
    </div>
  </I18nProvider>,
);
