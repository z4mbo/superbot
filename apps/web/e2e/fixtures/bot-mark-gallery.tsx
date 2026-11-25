import "../../src/styles.css";
import type { BotMarkInk } from "@rakazo/core";
import { BOT_MARK_PICKER_INKS, BOT_MARK_SHAPES, BOT_MARK_STATES } from "@rakazo/core";
import { BotMark, BotMarkSleep, BotMarkStill, GroupAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";

// Every body resting, still and asleep, every ink, groups of two to four, then every state on every
// body, and each state in the sizes the app uses (24 capsule, 28 working line, 36 roster row, 60
// pinned tile, 64 details).
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
    <div className="row" data-testid="stills">
      {BOT_MARK_SHAPES.map((shape, index) => (
        <BotMarkStill key={shape} shape={shape} ink={inks[index % inks.length]!} size={36} />
      ))}
    </div>
    <div className="row" data-testid="inks">
      {BOT_MARK_PICKER_INKS.map((ink) => (
        <BotMark key={ink} identity={`ink-${ink}`} shape="blob" ink={ink} size={36} />
      ))}
    </div>
    <div className="row" data-testid="groups">
      {[2, 3, 4].map((count) =>
        [36, 60].map((size) => (
          <GroupAvatar
            key={`${count}-${size}`}
            size={size}
            members={["#A97EFE", "#1CC3B0", "#FF5EB1", "#FFAF38"]
              .slice(0, count)
              .map((color, index) => ({
                botId: `group-${count}-${index}`,
                color,
              }))}
          />
        )),
      )}
    </div>
    <div className="row" data-testid="asleep">
      {BOT_MARK_SHAPES.map((shape) => (
        <div key={shape} className="cell">
          <BotMarkSleep>
            <BotMark
              identity={`asleep-${shape}`}
              shape={shape}
              ink="gray"
              state="asleep"
              size={36}
            />
          </BotMarkSleep>
        </div>
      ))}
    </div>
    {BOT_MARK_STATES.map((state) => (
      <div key={state} className="row" data-state={state}>
        <span>{state}</span>
        {BOT_MARK_SHAPES.map((shape, index) => (
          <BotMark
            key={shape}
            identity={`${state}-${shape}`}
            shape={shape}
            ink={state === "asleep" ? "gray" : inks[index % inks.length]!}
            state={state}
            size={36}
          />
        ))}
        {[24, 28, 36, 60, 64].map((size) => (
          <BotMark
            key={size}
            identity={`${state}-size`}
            shape="blob"
            ink={state === "asleep" ? "gray" : "neutral"}
            state={state}
            size={size}
          />
        ))}
      </div>
    ))}
    <div className="row" data-testid="showcase">
      <span>welcome</span>
      <BotMark identity="showcase" shape="blob" ink="neutral" size={64} showcase />
    </div>
  </>,
);
