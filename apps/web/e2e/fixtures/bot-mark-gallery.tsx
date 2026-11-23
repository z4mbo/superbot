import "../../src/styles.css";
import type { BotMarkInk } from "@rakazo/core";
import { BOT_MARK_SHAPES, BOT_MARK_STATES } from "@rakazo/core";
import { BotMark } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";

// Every shape at rest, then every state on a few shapes, in the inks and sizes the app uses.
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const inks: BotMarkInk[] = [
  "neutral",
  "blue",
  "cyan",
  "green",
  "magenta",
  "orange",
  "purple",
  "red",
  "yellow",
  "brown",
];

createRoot(document.getElementById("root")!).render(
  <>
    <div className="row" data-testid="shapes">
      {BOT_MARK_SHAPES.map((shape, index) => (
        <div key={shape} className="cell">
          <BotMark
            identity={`shape-${shape}`}
            shape={shape}
            ink={inks[index % inks.length]!}
            size={48}
          />
          {shape}
        </div>
      ))}
    </div>
    {BOT_MARK_STATES.map((state) => (
      <div key={state} className="row" data-state={state}>
        <span>{state}</span>
        {(["circle", "teardrop", "cloud", "egg"] as const).map((shape, index) => (
          <BotMark
            key={shape}
            identity={`${state}-${shape}`}
            shape={shape}
            ink={state === "asleep" ? "gray" : inks[index * 2]!}
            state={state}
            size={48}
          />
        ))}
        {[24, 28, 36, 60].map((size) => (
          <BotMark
            key={size}
            identity={`${state}-size`}
            shape="circle"
            ink="neutral"
            state={state}
            size={size}
          />
        ))}
      </div>
    ))}
    <div className="row" data-testid="showcase">
      <span>welcome</span>
      <BotMark identity="showcase" shape="circle" ink="neutral" size={64} showcase />
    </div>
  </>,
);
