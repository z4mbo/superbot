import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { endpoint } from "./mcp.mjs";

async function readSecret(prompt) {
  if (!process.stdin.isTTY) throw new Error("Superbot sign-in requires an interactive terminal.");
  process.stderr.write(prompt);
  const input = createInterface({
    input: process.stdin,
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    terminal: true,
  });
  try {
    return await input.question("");
  } finally {
    input.close();
    process.stderr.write("\n");
  }
}

export function superbot(server, token, space) {
  const url = endpoint(server, "/");
  const post = async (path, body, authorized = true) => {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(authorized && token && { authorization: `Bearer ${token}` }),
        ...(space && { "x-rakazo-space-id": space }),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
    return response;
  };

  return {
    async rpc(path, input) {
      const response = await post(`/rpc/${path}`, { json: input });
      return (await response.json()).json;
    },
    async signIn(email, emailCode) {
      if (!process.stdin.isTTY)
        throw new Error("Superbot sign-in requires an interactive terminal.");
      if (emailCode) {
        await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, false);
      }
      const response = emailCode
        ? await post(
            "/api/auth/sign-in/email-otp",
            {
              email,
              otp: (await readSecret("Superbot email sign-in code: ")).trim(),
            },
            false,
          )
        : await post(
            "/api/auth/sign-in/email",
            {
              email,
              password: await readSecret("Superbot password: "),
            },
            false,
          );
      const signed = response.headers.get("set-auth-token");
      if (!signed) throw new Error("Superbot did not issue a signed session.");
      return signed;
    },
    async signOut() {
      await post("/api/auth/sign-out", {});
    },
  };
}

export async function* pages(read, first) {
  let after;
  do {
    const { items, nextAfter } = await read({ ...first, ...(after && { after }) });
    if (!Array.isArray(items) || (nextAfter !== null && typeof nextAfter !== "string")) {
      throw new Error("Invalid Superbot page.");
    }
    yield items;
    if (nextAfter && after === nextAfter) throw new Error("Repeated Superbot page cursor.");
    after = nextAfter;
  } while (after);
}
