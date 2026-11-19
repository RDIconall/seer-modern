/**
 * Unsent mail must leave the browser when the session ends.
 *
 * The compose pane, the inline reply, and the legacy compose panel write the
 * recipient list, subject, and HTML body into localStorage under keys that
 * start with "seer:draft". Sign-out, account switch, and the login form are
 * supposed to delete those keys. These tests fail while the text is still
 * readable after those actions, and pass once it is deleted.
 *
 * Run: npx tsx scripts/v3-draft-signout.test.mts
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";

const PLACEHOLDER = "placeholder";
process.env.AUTH_GOOGLE_ID = PLACEHOLDER;
process.env.AUTH_GOOGLE_SECRET = PLACEHOLDER;
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = PLACEHOLDER;
process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = PLACEHOLDER;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const { window } = dom;

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.self = window;
globals.document = window.document;
globals.HTMLFormElement = window.HTMLFormElement;
globals.HTMLButtonElement = window.HTMLButtonElement;
globals.HTMLElement = window.HTMLElement;
globals.HTMLInputElement = window.HTMLInputElement;
globals.Element = window.Element;
globals.Node = window.Node;
globals.DocumentFragment = window.DocumentFragment;
globals.Event = window.Event;
globals.KeyboardEvent = window.KeyboardEvent;
globals.InputEvent = window.InputEvent;
globals.MutationObserver = window.MutationObserver;
globals.getSelection = () => window.getSelection();
globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globals.getComputedStyle = window.getComputedStyle.bind(window);
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.React = React;
Object.defineProperty(globals, "navigator", {
  value: window.navigator,
  configurable: true,
});

if (!("oninput" in window.document)) {
  window.document.oninput = null;
}

const clientRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    bottom: 16,
    left: 0,
    right: 16,
    width: 16,
    height: 16,
    toJSON() {
      return {};
    },
  }) as DOMRect;

const NativeFormData = globalThis.FormData;
class TestFormData extends NativeFormData {
  constructor(form?: unknown) {
    super();
    if (
      form &&
      typeof form === "object" &&
      "elements" in form &&
      form.elements &&
      typeof (form.elements as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
        "function"
    ) {
      for (const element of form.elements as Iterable<Element>) {
        if (
          element instanceof window.HTMLInputElement &&
          element.name &&
          !element.disabled
        ) {
          this.append(element.name, element.value);
        }
      }
    }
  }
}
globals.FormData = TestFormData;
window.FormData = TestFormData as unknown as typeof window.FormData;

for (const prototype of [window.Element.prototype, window.Text.prototype, window.Range.prototype]) {
  prototype.getClientRects = function getClientRects() {
    return [clientRect()] as unknown as DOMRectList;
  };
  prototype.getBoundingClientRect = function getBoundingClientRect() {
    return clientRect();
  };
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
}

const { createRoot } = await import("react-dom/client");
const { SearchParamsContext } = await import(
  "next/dist/shared/lib/hooks-client-context.shared-runtime.js"
);
const { draftStorageKey, parseStoredDraft } = await import(
  "../src/lib/v3/compose/draft.ts"
);
const { MAILBOX_CACHE_KEY_PREFIX } = await import(
  "../src/lib/v3/mailbox/cache.ts"
);
const { ComposePane } = await import("../src/components/v3/ComposePane.tsx");
const { InlineReply } = await import("../src/components/v3/InlineReply.tsx");
const { Settings } = await import("../src/components/v3/Settings.tsx");
const { ACCOUNT_CHANGED_EVENT, useMailbox } = await import(
  "../src/components/v3/useMailbox.ts"
);
const { ComposePanel } = await import("../src/components/inbox/ComposePanel.tsx");
const { SettingsPanel } = await import(
  "../src/components/inbox/SettingsPanel.tsx"
);
const { DesktopMailApp } = await import(
  "../src/components/inbox/DesktopMailApp.tsx"
);
const { MobileMailApp } = await import(
  "../src/components/inbox/MobileMailApp.tsx"
);
const {
  DesktopLoginScreen,
  MobileLoginScreen,
  SessionExpiredScreen,
} = await import("../src/components/auth/AuthScreens.tsx");
const { v3Preview } = await import("../src/app/dev/preview/v3-sample.ts");

const ACTIVE = "acct-active";
const OTHER = "acct-other";
const PRESERVED_KEY = "seer:collapsed:board";
const PRESERVED_VALUE = '["atlas"]';
const MAILBOX_KEY = `${MAILBOX_CACHE_KEY_PREFIX}7.${ACTIVE}.inbox.date`;

const COMPOSE_BODY = "Offer expires Friday. Do not forward.";
const OTHER_BODY = "Second mailbox draft for the other account.";
const ANONYMOUS_BODY = "Draft saved before an account id was known.";
const REPLY_BODY = "Reply that was never sent.";
const FORWARD_BODY = "Forwarding note still unsent.";
const LEGACY_BODY = "Legacy compose body that was not sent.";
const RECIPIENT = "buyer@example.com";
const OTHER_RECIPIENT = "other-buyer@example.com";
const FORWARD_RECIPIENT = "forward-to@example.com";
const LEGACY_RECIPIENT = "legacy-to@example.com";
const SUBJECT = "Unsent offer for Example Street";
const OTHER_SUBJECT = "Unsent note on the other mailbox";
const ANONYMOUS_SUBJECT = "Unsent note with no account id";
const LEGACY_SUBJECT = "Legacy unsent subject";

type CapturedDraft = { key: string; raw: string; secret: string };

const accountList = {
  active: {
    id: ACTIVE,
    provider: "google" as const,
    email: "victim@example.com",
    name: "Victim",
    label: "Work",
    active: true,
    status: "active" as const,
  },
  accounts: [
    {
      id: ACTIVE,
      provider: "google" as const,
      email: "victim@example.com",
      name: "Victim",
      label: "Work",
      active: true,
      status: "active" as const,
    },
    {
      id: OTHER,
      provider: "microsoft" as const,
      email: "other@example.com",
      name: "Other",
      label: "Other",
      active: false,
      status: "active" as const,
    },
  ],
  available: { google: false, microsoft: false },
  sessionError: null,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(requestUrl(input), "http://localhost/");
  const method = init?.method ?? "GET";
  if (url.pathname === "/api/v3/accounts" && method === "POST") {
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      id?: string;
      action?: string;
    };
    if (payload.action === "remove" && payload.id === ACTIVE) {
      return jsonResponse({ requiresSignOut: true });
    }
    return jsonResponse({});
  }
  if (url.pathname === "/api/v3/accounts" || url.pathname === "/api/accounts") {
    return jsonResponse(accountList);
  }
  if (url.pathname === "/api/v2/operating-model") {
    return jsonResponse({
      functions: [],
      topics: [],
      guidance: "",
      proposal: null,
      proposedAt: null,
      acceptedAt: null,
    });
  }
  if (url.pathname === "/api/v3/contacts" || url.pathname === "/api/contacts") {
    return jsonResponse({ suggestions: [], contacts: [] });
  }
  return jsonResponse({ error: "not used by this test" }, 404);
};

function mount(node: ReactNode): { container: HTMLElement; unmount: () => void } {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function withSearchParams(node: ReactNode): ReactNode {
  return createElement(
    SearchParamsContext.Provider,
    { value: new URLSearchParams() },
    node,
  );
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await delay(ms);
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function waitForEditor(container: ParentNode): Promise<HTMLElement> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const editor = container.querySelector<HTMLElement>("[contenteditable='true']");
    if (editor) return editor;
    await settle(20);
  }
  throw new Error("rich text editor did not mount");
}

/**
 * The editor commits clipboard text through ProseMirror's paste handler
 * (prosemirror-view 1.42.2, editHandlers.paste), which is what RichComposer
 * mounts. A synthetic paste carries the same plain text and HTML a user paste
 * delivers to that handler.
 */
function pasteIntoEditor(editor: HTMLElement, text: string): void {
  const clipboardData = {
    getData(type: string) {
      if (type === "text/plain" || type === "Text") return text;
      if (type === "text/html") return `<p>${text}</p>`;
      return "";
    },
  };
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  editor.dispatchEvent(event);
}

function commitRecipient(container: ParentNode, email: string): void {
  const input = container.querySelector<HTMLInputElement>(
    "input.mail-recipient-input",
  );
  if (!input) throw new Error("recipient field missing");
  setInput(input, email);
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function waitForDraft(key: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const raw = window.localStorage.getItem(key);
    if (raw) return raw;
    await settle(50);
  }
  throw new Error(`composer did not store ${key}`);
}

function expectStored(
  key: string,
  raw: string,
  fields: { recipients?: string[]; subject?: string; body: string },
): void {
  const draft = parseStoredDraft(raw);
  assert.ok(draft, `${key} is not a compose draft`);
  assert.equal(draft.subject, fields.subject ?? "");
  assert.ok(
    draft.bodyText.includes(fields.body),
    `${key} body text does not include the unsent message`,
  );
  assert.ok(
    draft.bodyHtml.includes(fields.body),
    `${key} HTML body does not include the unsent message`,
  );
  for (const email of fields.recipients ?? []) {
    assert.ok(
      draft.recipients.includes(email),
      `${key} recipients do not include ${email}`,
    );
  }
  assert.equal(key.startsWith("seer:draft"), true);
}

async function captureCompose(options: {
  accountId?: string;
  subject: string;
  recipient: string;
  body: string;
}): Promise<CapturedDraft> {
  const key = draftStorageKey(options.accountId, "send");
  const view = mount(
    createElement(ComposePane, {
      accountId: options.accountId,
      onClose() {},
      onSent() {},
    }),
  );
  try {
    const editor = await waitForEditor(view.container);
    await settle();
    await act(async () => {
      const subject = view.container.querySelector<HTMLInputElement>(
        "input.mail-compose-subject",
      );
      if (!subject) throw new Error("subject field missing");
      setInput(subject, options.subject);
      commitRecipient(view.container, options.recipient);
      pasteIntoEditor(editor, options.body);
    });
    const raw = await waitForDraft(key);
    expectStored(key, raw, {
      recipients: [options.recipient],
      subject: options.subject,
      body: options.body,
    });
    assert.match(view.container.textContent ?? "", /Draft saved/);
    return { key, raw, secret: options.body };
  } finally {
    view.unmount();
  }
}

async function captureInline(options: {
  mode: "reply" | "forward";
  body: string;
  recipient?: string;
}): Promise<CapturedDraft> {
  const key = draftStorageKey(ACTIVE, options.mode, "thread/42");
  const view = mount(
    createElement(InlineReply, {
      conversation: v3Preview.reader.conversation,
      providerConversationId: "thread/42",
      accountId: ACTIVE,
      intent: { mode: options.mode },
      onActivate() {},
      onClose() {},
      onExpand() {},
      onSent() {},
    }),
  );
  try {
    const editor = await waitForEditor(view.container);
    await settle();
    await act(async () => {
      if (options.recipient) commitRecipient(view.container, options.recipient);
      pasteIntoEditor(editor, options.body);
    });
    const raw = await waitForDraft(key);
    expectStored(key, raw, {
      recipients: options.recipient ? [options.recipient] : [],
      body: options.body,
    });
    assert.equal(
      key,
      `seer:draft:${ACTIVE}:${options.mode}:thread%2F42`,
      "conversation id must be part of the stored key",
    );
    return { key, raw, secret: options.body };
  } finally {
    view.unmount();
  }
}

async function captureLegacy(): Promise<CapturedDraft> {
  const key = draftStorageKey("legacy", "compose");
  const view = mount(
    createElement(ComposePanel, {
      draft: {
        mode: "compose",
        to: "",
        cc: "",
        subject: "",
        body: "",
      },
      onClose() {},
      onSent() {},
    }),
  );
  try {
    const editor = await waitForEditor(view.container);
    await settle();
    await act(async () => {
      const to = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="Recipients"]',
      );
      const subject = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="Subject"]',
      );
      if (!to || !subject) throw new Error("legacy compose fields missing");
      setInput(to, LEGACY_RECIPIENT);
      setInput(subject, LEGACY_SUBJECT);
      pasteIntoEditor(editor, LEGACY_BODY);
    });
    const raw = await waitForDraft(key);
    expectStored(key, raw, {
      recipients: [LEGACY_RECIPIENT],
      subject: LEGACY_SUBJECT,
      body: LEGACY_BODY,
    });
    return { key, raw, secret: LEGACY_BODY };
  } finally {
    view.unmount();
  }
}

function restore(drafts: CapturedDraft[]): void {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const draft of drafts) window.localStorage.setItem(draft.key, draft.raw);
  window.localStorage.setItem(PRESERVED_KEY, PRESERVED_VALUE);
  window.localStorage.setItem(MAILBOX_KEY, '{"savedAt":1}');
}

function assertDraftsGone(drafts: CapturedDraft[]): void {
  const secrets = [
    ...drafts.map((draft) => draft.secret),
    RECIPIENT,
    OTHER_RECIPIENT,
    FORWARD_RECIPIENT,
    LEGACY_RECIPIENT,
    SUBJECT,
    OTHER_SUBJECT,
    ANONYMOUS_SUBJECT,
    LEGACY_SUBJECT,
  ];
  const stored: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key) continue;
      stored.push(`${key}=${store.getItem(key) ?? ""}`);
      if (store === window.localStorage) {
        assert.equal(
          key.startsWith("seer:draft"),
          false,
          `draft key still in localStorage: ${key}`,
        );
      }
    }
  }
  for (const secret of secrets) {
    const hit = stored.find((entry) => entry.includes(secret));
    assert.equal(hit, undefined, `unsent mail still stored: ${hit ?? secret}`);
  }
  assert.equal(
    window.localStorage.getItem(PRESERVED_KEY),
    PRESERVED_VALUE,
    "sign-out deleted an unrelated localStorage key",
  );
}

function assertMailboxCleared(): void {
  assert.equal(
    window.localStorage.getItem(MAILBOX_KEY),
    null,
    "the mailbox-list cache was not cleared, so this action did not run the existing cleanup",
  );
}

async function press(button: HTMLElement): Promise<string[]> {
  const notes: string[] = [];
  const onRejection = (reason: unknown) => {
    notes.push(reason instanceof Error ? reason.message : String(reason));
  };
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    notes.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  process.on("unhandledRejection", onRejection);
  try {
    await act(async () => {
      button.click();
    });
    await settle();
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error));
  } finally {
    console.error = previous;
    process.off("unhandledRejection", onRejection);
  }
  return notes;
}

function assertSessionActionRan(notes: string[]): void {
  assert.ok(
    notes.some((note) => note.includes("outside a request scope")),
    `sign-in or sign-out action did not run (${notes.join(" | ") || "no error"})`,
  );
}

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((button) => {
    const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
    return (
      text === label ||
      text.startsWith(`${label} `) ||
      button.getAttribute("aria-label") === label
    );
  });
  if (!(match instanceof window.HTMLButtonElement)) {
    throw new Error(`button not found: ${label}`);
  }
  return match;
}

function buttonInRow(
  container: ParentNode,
  email: string,
  label: string,
): HTMLButtonElement {
  const row = [...container.querySelectorAll("li")].find((item) =>
    item.textContent?.includes(email),
  );
  if (!row) throw new Error(`account row not found: ${email}`);
  const match = [...row.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label),
  );
  if (!(match instanceof window.HTMLButtonElement) || match.disabled) {
    throw new Error(`${label} button not found for ${email}`);
  }
  return match;
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  }
}

const drafts: CapturedDraft[] = [];
drafts.push(
  await captureCompose({
    accountId: ACTIVE,
    subject: SUBJECT,
    recipient: RECIPIENT,
    body: COMPOSE_BODY,
  }),
);
drafts.push(
  await captureCompose({
    accountId: OTHER,
    subject: OTHER_SUBJECT,
    recipient: OTHER_RECIPIENT,
    body: OTHER_BODY,
  }),
);
drafts.push(
  await captureCompose({
    subject: ANONYMOUS_SUBJECT,
    recipient: RECIPIENT,
    body: ANONYMOUS_BODY,
  }),
);
drafts.push(await captureInline({ mode: "reply", body: REPLY_BODY }));
drafts.push(
  await captureInline({
    mode: "forward",
    body: FORWARD_BODY,
    recipient: FORWARD_RECIPIENT,
  }),
);
drafts.push(await captureLegacy());

window.confirm = () => true;

await check("v3 settings sign-out", async () => {
  restore(drafts);
  const view = mount(createElement(Settings, {}));
  try {
    await settle(50);
    const button = view.container.querySelector(
      "form.mail-settings-signout button",
    );
    if (!(button instanceof window.HTMLButtonElement)) {
      throw new Error("settings sign-out button missing");
    }
    const notes = await press(button);
    assertSessionActionRan(notes);
    assertMailboxCleared();
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("v3 settings account switch", async () => {
  restore(drafts);
  const view = mount(createElement(Settings, {}));
  try {
    await settle(50);
    const notes = await press(buttonInRow(view.container, "other@example.com", "Switch"));
    assert.equal(
      notes.some((note) => note.includes("outside a request scope")),
      false,
    );
    assertMailboxCleared();
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("v3 settings remove account", async () => {
  restore(drafts);
  const view = mount(createElement(Settings, {}));
  try {
    await settle(50);
    await press(buttonInRow(view.container, "other@example.com", "Remove"));
    assertMailboxCleared();
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("v3 settings remove account that signs out", async () => {
  restore(drafts);
  const view = mount(createElement(Settings, {}));
  try {
    await settle(50);
    await press(buttonInRow(view.container, "victim@example.com", "Remove"));
    assert.match(
      view.container.textContent ?? "",
      /outside a request scope/,
      "removing the last account did not reach sign-out",
    );
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

async function submitLogin(screen: ReactNode, label: string): Promise<void> {
  restore(drafts);
  const view = mount(screen);
  try {
    await settle();
    const button = buttonNamed(view.container, label);
    const notes = await press(button);
    assertSessionActionRan(notes);
    assertMailboxCleared();
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
}

await check("desktop login", () =>
  submitLogin(createElement(DesktopLoginScreen), "Continue with Google"),
);
await check("mobile login", () =>
  submitLogin(createElement(MobileLoginScreen), "Continue with Microsoft"),
);
await check("desktop session-expired sign-out", () =>
  submitLogin(createElement(SessionExpiredScreen, {}), "Sign out and reconnect"),
);
await check("mobile session-expired sign-out", () =>
  submitLogin(
    createElement(SessionExpiredScreen, { mobile: true }),
    "Sign out and reconnect",
  ),
);

await check("legacy settings sign-out", async () => {
  restore(drafts);
  const view = mount(
    createElement(SettingsPanel, {
      onClose() {},
    }),
  );
  try {
    await settle(50);
    const notes = await press(buttonNamed(view.container, "Sign out"));
    assertSessionActionRan(notes);
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("legacy mobile settings sign-out", async () => {
  restore(drafts);
  const view = mount(
    createElement(SettingsPanel, {
      mobile: true,
      onClose() {},
    }),
  );
  try {
    await settle(50);
    const notes = await press(buttonNamed(view.container, "Sign out"));
    assertSessionActionRan(notes);
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("desktop mailbox sign-out", async () => {
  restore(drafts);
  const view = mount(withSearchParams(createElement(DesktopMailApp)));
  try {
    await settle(50);
    const notes = await press(buttonNamed(view.container, "Sign out"));
    assertSessionActionRan(notes);
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

await check("mobile mailbox sign-out", async () => {
  restore(drafts);
  const view = mount(withSearchParams(createElement(MobileMailApp)));
  try {
    await settle(50);
    await press(buttonNamed(view.container, "Menu"));
    const notes = await press(buttonNamed(view.container, "Sign out"));
    assertSessionActionRan(notes);
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

function MailboxProbe() {
  useMailbox("inbox");
  return null;
}

await check("account-changed event", async () => {
  restore(drafts);
  const view = mount(createElement(MailboxProbe));
  try {
    await settle(50);
    await act(async () => {
      window.dispatchEvent(new window.Event(ACCOUNT_CHANGED_EVENT));
    });
    await settle();
    assertMailboxCleared();
    assertDraftsGone(drafts);
  } finally {
    view.unmount();
  }
});

if (failures.length > 0) {
  console.error(`v3-draft-signout: ${failures.length} failed`);
  for (const failure of failures) console.error(`\n${failure}`);
  process.exitCode = 1;
} else {
  console.log("v3-draft-signout: OK");
}
