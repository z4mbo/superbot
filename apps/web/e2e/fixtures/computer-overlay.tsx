import { I18nProvider } from "@lingui/react";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { WindowControls } from "../../src/components/WindowControls";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { ComputerOverlay } from "../../src/pages/shell/computers/computer-overlay";
import "../../src/styles.css";

// `?control=takeover` shows the actions of someone holding control while the bot asks it back;
// otherwise a running bot's Stop and Take control. `?theme=light` picks the light theme. With a
// desktop bridge, the window's own controls show at the top right as in the app.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const takeover = params.get("control") === "takeover";

const bot = {
  id: "fixture-bot",
  name: "Research assistant with a long name",
  color: "#1E86FC",
  status: "working",
} as Bot;

const computer: ComputerStatus = {
  botId: bot.id,
  mode: "dedicated",
  kind: "fixture",
  state: "running",
  controlHolder: takeover ? "user" : "bot",
  controlBotId: null,
  takeoverRequested: takeover,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: null,
  canUpdate: false,
  terminalAvailable: false,
};

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <ComputerOverlay
        bot={bot}
        computer={computer}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={takeover}
        composerRunning
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={() => undefined}
        onRefreshTeaching={async () => undefined}
        onClose={() => undefined}
      />
      <WindowControls />
    </I18nProvider>,
  );
});
