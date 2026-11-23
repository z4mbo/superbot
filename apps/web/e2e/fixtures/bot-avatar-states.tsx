import "../../src/styles.css";
import type { LogoAvatarActivity } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";

// Every shipped shape, one per colour, in each state the avatar shows.
const SHAPES = [
  "#2A92FE",
  "#A97EFE",
  "#00C972",
  "#FF781C",
  "#FF5EB1",
  "#1CC3B0",
  "#A27952",
  "#FF3E51",
];
const STATES: { label: string; activity: LogoAvatarActivity }[] = [
  { label: "Idle", activity: "idle" },
  { label: "Working", activity: "working" },
  { label: "Thinking", activity: "thinking" },
  { label: "Waiting", activity: "waiting" },
  { label: "Blocked", activity: "error" },
];

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const size = Number(params.get("size") ?? 56);

function Row({ label, activity }: { label: string; activity: LogoAvatarActivity }) {
  return (
    <div className="avatar-row" data-state={activity}>
      <span>{label}</span>
      {SHAPES.map((color, shape) => (
        <BotAvatar
          key={color}
          color={`${color}::shape_${shape}`}
          identity={`state-${activity}-${shape}`}
          size={size}
          activity={activity}
          status={activity === "idle" ? "idle" : "running"}
          className={`avatar-shape-${shape}`}
        />
      ))}
    </div>
  );
}

/** Done is the moment work ends: toggling back to idle plays one settling turn. */
function DoneRow() {
  const [working, setWorking] = useState(true);
  return (
    <div className="avatar-row" data-state="done">
      <span>Done</span>
      {SHAPES.map((color, shape) => (
        <BotAvatar
          key={color}
          color={`${color}::shape_${shape}`}
          identity={`state-done-${shape}`}
          size={size}
          activity={working ? "working" : "idle"}
          status={working ? "running" : "idle"}
          className={`avatar-shape-${shape}`}
        />
      ))}
      <button type="button" onClick={() => setWorking((value) => !value)}>
        {working ? "Finish" : "Start"}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    {STATES.map((state) => (
      <Row key={state.activity} {...state} />
    ))}
    <DoneRow />
  </>,
);
