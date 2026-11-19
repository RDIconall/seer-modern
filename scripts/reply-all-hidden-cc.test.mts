/**
 * Reply-all must deliver only the addresses the user was shown, and those
 * addresses have to be the mailbox addresses, not display names.
 *
 * A sender can put their own mailbox in Cc under an innocuous name. The open
 * turn has to show that Cc address. Reply-all compose (inline and expanded)
 * has to show the exact set that will be addressed — latest From, To, and Cc,
 * minus the account — before send. That set is pinned on the reply command
 * (`recipients`: the email strings). `ownEmail` is the account to leave off
 * that list. The command bus must hand the list to the provider. Gmail's raw
 * message and Outlook's request must address that set
 * and the text the user just typed, even when a later read of the thread
 * gains another Cc. A send that re-reads To/Cc at submit time, or that posts
 * Graph replyAll and lets the provider choose recipients, still fails.
 *
 * The legacy inbox is not covered. Its reader prints Cc and its compose pane
 * has a Cc field, so this hidden-Cc path is the v3 client.
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Command } from "../src/lib/v2/commands/types.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { draftStorageKey, type StoredDraft } from "../src/lib/v3/compose/draft.ts";

const SELF = "victim@rdi.example";
const THREAD = "thread-hidden-cc";
const NEW_TEXT = "The password is swordfish";
const ATTACKER = "attacker@evil.example";
const SNEAKY = "sneaky@hidden.example";
const OLD_CC = "old-cc@vendor.example";

const failures: string[] = [];

function check(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  Object.defineProperty(globals, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Element = dom.window.Element;
  globals.Node = dom.window.Node;
  globals.DocumentFragment = dom.window.DocumentFragment;
  globals.getSelection = dom.window.document.getSelection?.bind(dom.window.document);
  globals.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

installDom();

const { Reader } = await import("../src/components/v2/Reader.tsx");
const { InlineReply } = await import("../src/components/v3/InlineReply.tsx");
const { ComposePane } = await import("../src/components/v3/ComposePane.tsx");

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Cc added only after the conversation was shown. Empty during the first read. */
let ccAddedAfterDisplay = "";

function gmailMessage(
  id: string,
  epoch: number,
  from: string,
  to: string,
  cc: string,
): unknown {
  return {
    id,
    threadId: THREAD,
    snippet: "Please review the draft.",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(epoch),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Cc", value: cc },
        { name: "Subject", value: "Quarterly plan" },
      ],
      body: { size: 24, data: b64url("Please review the draft.") },
    },
  };
}

function latestCc(): string {
  const hidden = ccAddedAfterDisplay
    ? `, ${ccAddedAfterDisplay}`
    : "";
  return `Notes <${ATTACKER}>${hidden}`;
}

function gmailThread(): unknown {
  return {
    id: THREAD,
    messages: [
      gmailMessage(
        "m-new",
        1_700_000_100_000,
        "Alice Vendor <alice@vendor.example>",
        "Pat Colleague <pat@vendor.example>, Victim <victim@rdi.example>",
        latestCc(),
      ),
      gmailMessage(
        "m-old",
        1_700_000_000_000,
        "Alice Vendor <alice@vendor.example>",
        "Pat Colleague <pat@vendor.example>, Victim <victim@rdi.example>",
        `Archive <${OLD_CC}>`,
      ),
    ],
  };
}

function graphMessage(id: string, when: string, cc: { address: string; name?: string }[]): unknown {
  return {
    id,
    conversationId: THREAD,
    subject: "Quarterly plan",
    from: { emailAddress: { address: "alice@vendor.example", name: "Alice Vendor" } },
    toRecipients: [
      { emailAddress: { address: "pat@vendor.example", name: "Pat Colleague" } },
      { emailAddress: { address: SELF, name: "Victim" } },
    ],
    ccRecipients: cc.map((item) => ({
      emailAddress: { address: item.address, name: item.name },
    })),
    receivedDateTime: when,
    bodyPreview: "Please review the draft.",
    body: { contentType: "text", content: "Please review the draft." },
    isRead: false,
  };
}

function graphPage(): unknown {
  const cc = [{ address: ATTACKER, name: "Notes" }];
  if (ccAddedAfterDisplay) cc.push({ address: SNEAKY, name: "Notes" });
  return {
    value: [
      graphMessage("graph-old", "2026-08-01T10:00:00Z", [
        { address: OLD_CC, name: "Archive" },
      ]),
      graphMessage("graph-new", "2026-08-02T10:00:00Z", cc),
    ],
  };
}

let gmailRaw = "";
const outlookPosts: { url: string; body: string }[] = [];

const gmailFetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const u = String(url);
  if (method === "GET" && u.includes(`/threads/${THREAD}`)) {
    return new Response(JSON.stringify(gmailThread()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST" && u.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    gmailRaw = Buffer.from(
      String(body.raw ?? "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return new Response(JSON.stringify({ id: "sent-1", threadId: THREAD }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(`unexpected ${method} ${u}`, { status: 500 });
}) as typeof fetch;

const outlookFetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const u = String(url);
  if (method === "GET" && u.includes("conversationId")) {
    return new Response(JSON.stringify(graphPage()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST") {
    outlookPosts.push({ url: u, body: String(init?.body ?? "") });
    return new Response(null, { status: 202 });
  }
  return new Response(`unexpected ${method} ${u}`, { status: 500 });
}) as typeof fetch;

function replyAllEmails(message: Message, self: string): string[] {
  const own = self.toLowerCase();
  const all = [message.from, ...message.to, ...message.cc]
    .map((address) => address.email.toLowerCase())
    .filter((email) => email.length > 0 && email !== own);
  return [...new Set(all)].sort();
}

function emailsIn(value: string): string[] {
  return [
    ...value.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi),
  ].map((match) => match[0].toLowerCase());
}

function headerValue(raw: string, name: string): string {
  const header = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const match = header.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return match?.[1] ?? "";
}

function sameSet(actual: string[], expected: string[]): boolean {
  const left = [...new Set(actual.map((email) => email.toLowerCase()))].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((email, index) => email === right[index]);
}

function recipientEmails(command: Command & { recipients?: unknown }): string[] {
  const raw = command.recipients;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.toLowerCase();
      if (
        item &&
        typeof item === "object" &&
        "email" in item &&
        typeof item.email === "string"
      ) {
        return item.email.toLowerCase();
      }
      return "";
    })
    .filter((email) => email.length > 0);
}

function visibleText(html: string, select: (document: Document) => Element | null): string {
  const parsed = new JSDOM(html);
  const node = select(parsed.window.document);
  return node?.textContent ?? "";
}

const noop = () => {};

const shownProvider = new GmailProvider({
  accessToken: "test-token",
  accountEmail: SELF,
  fetchImpl: gmailFetch,
});
const shown = await shownProvider.getConversation(THREAD);
const latest = shown.messages[shown.messages.length - 1];
const expected = replyAllEmails(latest, SELF);

check(
  latest?.cc.some((address) => address.email === ATTACKER && address.name === "Notes"),
  `parsed latest Cc should be Notes <${ATTACKER}>, got ${JSON.stringify(latest?.cc)}`,
);
check(
  !expected.includes(OLD_CC) && !expected.includes(SELF) && expected.includes(ATTACKER),
  `reply-all set should be the latest message minus self, got ${expected.join(", ")}`,
);

const readerHtml = renderToString(
  createElement(Reader, {
    provider: "google",
    conversation: shown,
    ownEmail: SELF,
    onReply: noop,
    onReplyAll: noop,
    onForward: noop,
    onArchive: noop,
    onDelete: noop,
  }),
);
const openTurn = visibleText(readerHtml, (document) => {
  const turn = document.querySelector('[data-open="true"] .reader-turn-body');
  turn?.querySelector(".seer-message-text")?.remove();
  return turn;
});
check(
  openTurn.includes(ATTACKER),
  `open turn must show the Cc address ${ATTACKER}, not only the display name. Visible recipient text: ${JSON.stringify(openTurn)}`,
);

const inlineHtml = renderToString(
  createElement(InlineReply, {
    conversation: shown,
    providerConversationId: THREAD,
    accountId: "acct-1",
    ownEmail: SELF,
    intent: { mode: "replyAll" },
    onActivate: noop,
    onClose: noop,
    onExpand: noop,
    onSent: noop,
  }),
);
const inlineContext = visibleText(inlineHtml, (document) =>
  document.querySelector(".inline-reply-context"),
);
for (const email of expected) {
  check(
    inlineContext.includes(email),
    `inline reply-all must list ${email} before send. Context: ${JSON.stringify(inlineContext)}`,
  );
}

const composeHtml = renderToString(
  createElement(ComposePane, {
    intent: { mode: "replyAll" },
    providerConversationId: THREAD,
    conversationId: "corpus-1",
    accountId: "acct-1",
    ownEmail: SELF,
    preview: shown,
    previewProvider: "google",
    onClose: noop,
    onSent: noop,
  }),
);
const composeRecipients = visibleText(composeHtml, (document) => {
  const pane = document.querySelector(".mail-compose");
  pane?.querySelector(".mail-compose-quote")?.remove();
  pane?.querySelector(".mail-rich-composer")?.remove();
  return pane;
});
for (const email of expected) {
  check(
    composeRecipients.includes(email),
    `expanded reply-all must list ${email} outside the quoted thread. Visible text: ${JSON.stringify(composeRecipients.slice(0, 500))}`,
  );
}

function seedDraft(accountId: string): void {
  const draft: StoredDraft = {
    recipients: [],
    subject: "",
    bodyHtml: `<p>${NEW_TEXT}</p>`,
    bodyText: NEW_TEXT,
    savedAt: "2026-08-02T12:00:00.000Z",
  };
  const key = draftStorageKey(accountId, "replyAll", THREAD);
  window.localStorage.setItem(key, JSON.stringify(draft));
}

async function postedCommand(
  render: (root: Root) => void,
): Promise<(Command & { recipients?: unknown }) | null> {
  seedDraft("acct-1");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let posted: (Command & { recipients?: unknown }) | null = null;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/api/v2/commands") && init?.body) {
      const body = JSON.parse(String(init.body)) as {
        command?: Command & { recipients?: unknown };
      };
      posted = body.command ?? null;
      return new Response(
        JSON.stringify({ result: { ok: true, replayed: false } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return previous(url, init);
  }) as typeof fetch;
  try {
    await act(async () => {
      render(root);
    });
    const button = host.querySelector<HTMLButtonElement>("button[type='submit']");
    check(button !== null && button.disabled === false, "reply-all submit control was not enabled");
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  } finally {
    globalThis.fetch = previous;
    await act(async () => {
      root.unmount();
    });
    host.remove();
    window.localStorage.clear();
  }
  return posted;
}

const inlineCommand = await postedCommand((root) => {
  root.render(
    createElement(InlineReply, {
      conversation: shown,
      providerConversationId: THREAD,
      accountId: "acct-1",
      ownEmail: SELF,
      intent: { mode: "replyAll" },
      onActivate: noop,
      onClose: noop,
      onExpand: noop,
      onSent: noop,
    }),
  );
});
const composeCommand = await postedCommand((root) => {
  root.render(
    createElement(ComposePane, {
      intent: { mode: "replyAll" },
      providerConversationId: THREAD,
      conversationId: "corpus-1",
      accountId: "acct-1",
      ownEmail: SELF,
      preview: shown,
      previewProvider: "google",
      onClose: noop,
      onSent: noop,
    }),
  );
});

function assertCommand(
  label: string,
  command: (Command & { recipients?: unknown }) | null,
): void {
  check(command?.type === "reply" && command.all === true, `${label} must submit a reply-all command`);
  check(
    String(command?.bodyHtml ?? "").includes(NEW_TEXT),
    `${label} must send the text the user typed`,
  );
  const pinned = recipientEmails(command ?? ({ type: "reply" } as Command));
  check(
    sameSet(pinned, expected),
    `${label} must pin recipients to ${expected.join(", ")} on command.recipients. Got ${JSON.stringify(command)}`,
  );
}

assertCommand("inline reply-all", inlineCommand);
assertCommand("expanded reply-all", composeCommand);

async function deliver(
  command: (Command & { recipients?: unknown }) | null,
  key: string,
  provider: GmailProvider | OutlookProvider,
  db: TestDb,
): Promise<void> {
  if (!command) return;
  const userId = await upsertUser(`user-${key}@rdi.example`);
  const accountId = await upsertAccount({
    userId,
    provider: provider.kind,
    email: SELF,
  });
  ccAddedAfterDisplay = `Sneaky <${SNEAKY}>`;
  gmailRaw = "";
  outlookPosts.length = 0;
  const result = await executeCommand(
    { accountId, provider },
    command,
    key,
  );
  check(result.ok === true, `${key} execute failed: ${result.error ?? "unknown"}`);
}

let db: TestDb | null = null;
try {
  db = await startTestDb();
  if (inlineCommand) {
    await deliver(
      inlineCommand,
      "reply-all-inline-gmail",
      new GmailProvider({
        accessToken: "test-token",
        accountEmail: SELF,
        fetchImpl: gmailFetch,
      }),
      db,
    );
    const transmitted = [
      ...emailsIn(headerValue(gmailRaw, "To")),
      ...emailsIn(headerValue(gmailRaw, "Cc")),
    ];
    check(
      gmailRaw.includes(NEW_TEXT),
      `Gmail raw message must contain the new text. Raw: ${JSON.stringify(gmailRaw.slice(0, 400))}`,
    );
    check(
      sameSet(transmitted, expected) && !transmitted.includes(SNEAKY) && !transmitted.includes(OLD_CC),
      `Gmail reply-all addressed ${transmitted.join(", ") || "(nobody)"}; expected ${expected.join(", ")} and not ${SNEAKY} or ${OLD_CC}`,
    );

    await deliver(
      inlineCommand,
      "reply-all-inline-outlook",
      new OutlookProvider({
        accessToken: "test-token",
        accountEmail: SELF,
        fetchImpl: outlookFetch,
      }),
      db,
    );
    const replyAll = outlookPosts.find((post) => /\/replyAll(?:\?|$)/.test(post.url));
    const carrying = outlookPosts.find((post) => post.body.includes(NEW_TEXT));
    const addressed = emailsIn(carrying?.body ?? "");
    check(
      replyAll === undefined,
      `Outlook reply-all must not call Graph replyAll (that action addresses the stored To and Cc). Posts: ${JSON.stringify(outlookPosts)}`,
    );
    check(
      carrying !== undefined &&
        sameSet(addressed, expected) &&
        !addressed.includes(SNEAKY) &&
        !addressed.includes(OLD_CC),
      `Outlook request addressed ${addressed.join(", ") || "(nobody)"}; expected ${expected.join(", ")}. Posts: ${JSON.stringify(outlookPosts)}`,
    );
  }
  if (composeCommand && inlineCommand) {
    const inlinePinned = recipientEmails(inlineCommand).join(",");
    const composePinned = recipientEmails(composeCommand).join(",");
    check(
      inlinePinned === composePinned && inlinePinned.length > 0,
      "inline and expanded reply-all must pin the same recipient list",
    );
  }
} finally {
  await db?.stop();
}

if (failures.length > 0) {
  assert.fail(`reply-all hidden Cc\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log("reply-all-hidden-cc: OK");
