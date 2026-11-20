// The connect page sends the browser to a Superbot server the visitor runs. Nothing is fetched,
// stored or read from this page's URL except the destination, which is one of three fixed paths.

const DESTINATIONS = new Map([
  ["app", "/app"],
  ["sign-in", "/sign-in"],
  ["sign-up", "/sign-up"],
]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The path to open on the server, from this page's `?next=`; anything unknown opens the app. */
export function destination(search) {
  return DESTINATIONS.get(new URLSearchParams(search).get("next") ?? "") ?? "/app";
}

/**
 * The origin of the server the visitor typed, as the URL parser reads it, or why it is refused.
 * A bare host means `https://`; plain `http://` is allowed only on this device.
 */
export function serverOrigin(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  // Whitespace, control and invisible formatting characters, and backslashes, which browsers
  // read as `/` and so can move the host somewhere other than where it appears to be.
  if (/[\s\p{Cc}\p{Cf}\p{Z}\\]/u.test(text)) return { ok: false, reason: "invalid" };

  let candidate = text;
  if (text.startsWith("//")) candidate = `https:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // No `scheme://`: `host`, `host:8443` or `user:pass@host`, whose colon starts a port or a
    // password, mean https; `javascript:…` and other `scheme:` forms stay, and are refused below.
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(text);
    if (!scheme || /^(?:\d*(?:[/?#]|$)|[^/?#]*@)/.test(text.slice(scheme[0].length))) {
      candidate = `https://${text}`;
    }
  }

  const [prefix, protocol] = /^([a-z][a-z0-9+.-]*):\/*/i.exec(candidate);
  if (!["http", "https"].includes(protocol.toLowerCase())) return { ok: false, reason: "scheme" };
  // An `@` anywhere before the path is a user name, even an empty one: `good.example@evil.example`.
  if (candidate.slice(prefix.length).split(/[/?#]/, 1)[0].includes("@")) {
    return { ok: false, reason: "credentials" };
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials" };

  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (!host || host.endsWith(".")) return { ok: false, reason: "invalid" };
  url.hostname = host;
  if (url.hostname !== host) return { ok: false, reason: "invalid" };
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return { ok: false, reason: "http" };
  return { ok: true, origin: url.origin };
}

const MESSAGES = {
  empty: "Enter your server's address.",
  invalid: "That isn't a valid server address.",
  credentials: "Remove the user name and password from the address.",
  scheme: "Use an https:// address.",
  http: "Use https://. Plain http:// works only for localhost.",
};

function connect(form) {
  const input = form.querySelector("input");
  const error = document.getElementById(input.dataset.error);
  const show = (reason) => {
    error.textContent = MESSAGES[reason];
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id);
    input.focus();
  };
  const clear = () => {
    error.hidden = true;
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  };
  input.addEventListener("input", () => {
    if (!error.hidden) clear();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const server = serverOrigin(input.value);
    if (!server.ok) return show(server.reason);
    clear();
    window.location.assign(`${server.origin}${destination(window.location.search)}`);
  });
}

if (typeof document !== "undefined") {
  for (const form of document.querySelectorAll("form[data-connect]")) connect(form);
}
