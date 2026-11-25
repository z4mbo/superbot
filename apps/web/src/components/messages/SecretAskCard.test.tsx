// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { LoginFieldInput } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
// A card's editor lists the vault's saved contacts; these forms need none.
vi.mock("../vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import type { AskBlock } from "./AskCard";
import { SecretAskCard } from "./SecretAskCard";

// Fixture values only: a test card number and a made-up password.
const PAN = "4242 4242 4242 4242";
const CVC = "123";
const PASSWORD = "fixture-pass-9f3";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type OnAnswer = (text: string, fields?: LoginFieldInput[], remember?: false) => Promise<void>;

async function render(block: AskBlock, onAnswer: OnAnswer = async () => undefined) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SecretAskCard
          block={block}
          canAnswer
          canDismiss
          onAnswer={onAnswer}
          onDismiss={async () => undefined}
        />
      </QueryClientProvider>,
    ),
  );
}

const card = () => container.querySelector<HTMLElement>('[data-testid="secret-ask-card"]')!;
const editor = () => document.querySelector<HTMLElement>('[data-testid="vault-editor"]');
const buttonIn = (scope: ParentNode | null, name: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name);

function field(label: string) {
  const labelled = [...(editor()?.querySelectorAll("label") ?? [])].find(
    (item) => item.textContent === label,
  )!;
  return document.getElementById(labelled.htmlFor) as HTMLInputElement;
}

async function typeIn(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fillCard() {
  await act(async () => buttonIn(card(), "Add")!.click());
  await typeIn(field("Card number"), PAN);
  await typeIn(field("Expiry"), "0830");
  await typeIn(field("Security code"), CVC);
}

/** Every visible or stored trace of the page: text, attributes and input values. */
function pageTraces() {
  const values = [...document.querySelectorAll("input")].map((input) => input.value);
  return `${document.body.innerHTML}\n${values.join("\n")}`;
}

function expectNoValues() {
  const traces = pageTraces();
  for (const value of [PAN, PAN.replaceAll(" ", ""), PASSWORD]) expect(traces).not.toContain(value);
  // The security code is three digits, so only its own input could hold it.
  expect([...document.querySelectorAll("input")].some((input) => input.value === CVC)).toBe(false);
}

const cardForm: AskBlock = {
  kind: "ask",
  text: "Card for checkout",
  input: "secret",
  credential: { name: "checkout_card", origin: "", auth: { type: "card" } },
  status: "pending",
};

const loginForm: AskBlock = {
  kind: "ask",
  text: "Sign in to Example",
  input: "secret",
  credential: {
    name: "example_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  },
  status: "pending",
};

it("names an empty form a Secure form and holds no value", async () => {
  await render(cardForm);
  expect(card().getAttribute("aria-label")).toBe("Secure form");
  expect(card().querySelector('[data-testid="secure-form-label"]')?.textContent).toBe(
    "Secure form",
  );
  expect(buttonIn(card(), "Add")).toBeDefined();
  expect(card().querySelector("input")).toBeNull();
  // A code is not a form for the vault.
  await render({ kind: "ask", text: "Code", input: "secret", purpose: "otp", status: "pending" });
  expect(card().querySelector('[data-testid="secure-form-label"]')).toBeNull();
});

it("sends a card for one use with Save to Vault off, clearing it while it is sent", async () => {
  const answer = deferred<void>();
  const onAnswer = vi.fn<OnAnswer>(() => answer.promise);
  await render(cardForm, onAnswer);
  await fillCard();
  const save = editor()!.querySelector<HTMLElement>('[role="switch"]')!;
  expect(save.getAttribute("aria-checked")).toBe("true");
  await act(async () => save.click());
  expect(buttonIn(editor(), "Continue")).toBeDefined();
  await act(async () => buttonIn(editor(), "Continue")!.click());

  // Submitting: the fields are already empty, and the form waits on the answer.
  expect(onAnswer).toHaveBeenCalledWith(
    JSON.stringify({ number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: CVC }),
    undefined,
    false,
  );
  expect(buttonIn(editor(), "Sending…")).toBeDefined();
  expectNoValues();

  await act(async () => answer.resolve());
  expect(editor()).toBeNull();
  expect(card().textContent).toContain("Sent");
  expect(buttonIn(card(), "Add")).toBeUndefined();
  expectNoValues();
});

it("saves a login to the vault and shows only Saved once done", async () => {
  const onAnswer = vi.fn<OnAnswer>(async () => undefined);
  await render(loginForm, onAnswer);
  await act(async () => buttonIn(card(), "Add")!.click());
  const inputs = editor()!.querySelectorAll<HTMLInputElement>(
    '[data-testid="login-field"] input:not([aria-label="Label"])',
  );
  await typeIn(inputs[0]!, "fixture-user@example.test");
  await typeIn(inputs[1]!, PASSWORD);
  await act(async () => buttonIn(editor(), "Save")!.click());
  expect(onAnswer).toHaveBeenCalledWith("", [
    { label: "Username", value: "fixture-user@example.test", hidden: false },
    { label: "Password", value: PASSWORD, hidden: true },
  ]);
  expect(card().textContent).toContain("Saved");
  expectNoValues();
});

it("shows a completed form after a reload without any value", async () => {
  await render({ ...cardForm, status: "answered", answer: "", remembered: false });
  expect(card().textContent).toContain("Sent");
  await render({ ...cardForm, status: "answered", answer: "" });
  expect(card().textContent).toContain("Saved");
  expect(card().querySelector("input")).toBeNull();
  expectNoValues();
});
