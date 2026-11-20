/**
 * Spoofed From display name must not be the only identity a reply shows.
 *
 * An outside sender chooses the display name. Gmail and Outlook keep that name
 * separate from the mailbox the reply is actually addressed to. These tests
 * follow that path: parse the provider payload, render the reading pane and
 * the reply surfaces, and send. They fail while the screen names someone else
 * and the note still goes to the mailbox on the message.
 *
 * Run: npx tsx scripts/spoofed-sender-reply.test.mts
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const USER = "me@company.example";
const ATTACKER = "attacker@evil.example";
const SPY = "spy@evil.example";
const TRUSTED = "pat.colleague@client.example";
const INTERNAL = "sam.internal@company.example";
const NOTE = "Please wire the retainer to the account we discussed.";
const EARLIER = "The retainer account number is 88421.";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const { window } = dom;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globals, "navigator", {
  value: window.navigator,
  configurable: true,
});
for (const key of [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "DocumentFragment",
  "DOMParser",
  "Range",
  "NodeFilter",
  "Text",
  "Comment",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
] as const) {
  globals[key] = window[key];
}
globals.getSelection = window.getSelection.bind(window);
globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globals.getComputedStyle = window.getComputedStyle.bind(window);
globals.IS_REACT_ACT_ENVIRONMENT = true;
window.localStorage.clear();

type CommandCall = { url: string; body: string };

const commandCalls: CommandCall[] = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = typeof init?.body === "string" ? init.body : "";
  commandCalls.push({ url, body });
  if (url.includes("/api/v2/commands")) {
    return new window.Response(
      JSON.stringify({ result: { ok: true, replayed: false } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new window.Response("not found", { status: 404 });
}) as typeof fetch;
globals.fetch = window.fetch;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { mailboxListLabel } = await import("../src/lib/v3/mailbox/list-label.ts");
const { InlineReply } = await import("../src/components/v3/InlineReply.tsx");
const { Reader } = await import("../src/components/v2/Reader.tsx");
const { ComposePane } = await import("../src/components/v3/ComposePane.tsx");

type Address = { email: string; name?: string };
type Message = {
  providerMessageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  sentAt: string;
  snippet: string;
  bodyHtml: string | null;
  bodyText: string | null;
  isUnread: boolean;
  isOutgoing: boolean;
  attachments: [];
};
type Conversation = {
  providerConversationId: string;
  subject: string;
  messages: Message[];
  lastMessageAt: string;
};

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  }
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeRaw(raw: string): string {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}

function headerValue(mime: string, name: string): string {
  const match = mime.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function addressesIn(header: string): string[] {
  return header
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function elementText(html: string, className: string): string[] {
  const pattern = new RegExp(
    `<([a-z0-9]+)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
    "gi",
  );
  return [...html.matchAll(pattern)].map((match) =>
    match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );
}

function gmailMessage(
  id: string,
  epoch: number,
  from: string,
  body: string,
  cc = "",
) {
  return {
    id,
    threadId: "thr-spoof",
    snippet: body.slice(0, 80),
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(epoch),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: `User <${USER}>` },
        ...(cc ? [{ name: "Cc", value: cc }] : []),
        { name: "Subject", value: "Retainer" },
      ],
      mimeType: "text/plain",
      body: { size: body.length, data: b64url(body) },
    },
  };
}

function gmailFetch(thread: { id: string; messages: unknown[] }) {
  const sends: { raw: string; threadId?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && String(url).includes(`/threads/${thread.id}`)) {
      return new Response(JSON.stringify(thread), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && String(url).endsWith("/messages/send")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        raw?: string;
        threadId?: string;
      };
      const raw = decodeRaw(body.raw ?? "");
      sends.push({ raw, threadId: body.threadId });
      return new Response(JSON.stringify({ id: "sent-1", threadId: body.threadId ?? "sent-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected gmail request ${method} ${url}`);
  }) as typeof fetch;
  return { fetchImpl, sends };
}

const now = Date.now();
const trustedEarlier = gmailMessage(
  "m-earlier",
  now - 2 * 86_400_000,
  `Pat Colleague <${TRUSTED}>`,
  EARLIER,
);
const internalNote = gmailMessage(
  "m-internal",
  now - 86_400_000,
  `Sam Internal <${INTERNAL}>`,
  "Checking this internally.",
);
const spoofedLatest = gmailMessage(
  "m-spoof",
  now,
  `Pat Colleague <${ATTACKER}>`,
  "Can you send that over?",
  `Finance <${SPY}>`,
);
const embeddedName = gmailMessage(
  "m-embedded",
  now,
  `${TRUSTED} <${ATTACKER}>`,
  "Use my other address.",
  `payroll@company.example <${SPY}>`,
);

function providerFor(
  messages: ReturnType<typeof gmailMessage>[],
): { provider: InstanceType<typeof GmailProvider>; sends: { raw: string; threadId?: string }[] } {
  const thread = { id: "thr-spoof", messages };
  const { fetchImpl, sends } = gmailFetch(thread);
  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: USER,
    fetchImpl,
  });
  return { provider, sends };
}

function visibleReply(html: string): string {
  return elementText(html, "inline-reply-context").join("\n");
}

function renderReply(conversation: Conversation, mode: "reply" | "replyAll"): string {
  return renderToStaticMarkup(
    createElement(InlineReply, {
      conversation,
      providerConversationId: conversation.providerConversationId,
      accountId: "acct-1",
      intent: { mode },
      onActivate: () => {},
      onClose: () => {},
      onExpand: () => {},
      onSent: () => {},
    }),
  );
}

function renderReader(conversation: Conversation, replyHtmlMode: "reply" | "replyAll" | null): string {
  const reply = replyHtmlMode
    ? createElement(InlineReply, {
        conversation,
        providerConversationId: conversation.providerConversationId,
        accountId: "acct-1",
        intent: { mode: replyHtmlMode },
        onActivate: () => {},
        onClose: () => {},
        onExpand: () => {},
        onSent: () => {},
      })
    : null;
  return renderToStaticMarkup(
    createElement(Reader, {
      provider: "google",
      conversation,
      ownEmail: USER,
      onReply: () => {},
      onReplyAll: () => {},
      onForward: () => {},
      onArchive: () => {},
      onDelete: () => {},
      replySlot: reply,
      replying: replyHtmlMode !== null,
    }),
  );
}

function assertShowsMailbox(text: string, mailbox: string, where: string) {
  assert.match(
    text,
    new RegExp(mailbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    `${where} must show the mailbox the reply will use (${mailbox})`,
  );
}

function controlName(element: Element): string {
  const parts = [element.getAttribute("aria-label") ?? ""];
  if (element instanceof window.HTMLButtonElement) parts.push(element.textContent ?? "");
  const id = element.getAttribute("id");
  if (id) {
    const label = window.document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) parts.push(label.textContent ?? "");
  }
  const wrapping = element.closest("label");
  if (wrapping) parts.push(wrapping.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function fillComposer(root: ParentNode, text: string) {
  await flush();
  const editor = root.querySelector<HTMLElement>('[aria-label="Message"]');
  assert.ok(editor, "composer did not mount");
  const tiptap = (
    editor as unknown as {
      editor?: { commands: { insertContent: (value: string) => boolean } };
    }
  ).editor;
  assert.ok(tiptap, "composer editor instance missing");
  await act(async () => {
    tiptap.commands.insertContent(text);
  });
  await flush();
  const submit = root.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.equal(submit?.disabled, false, "the note did not enable send");
}

/** The form handler the reply bar attached. jsdom's submit event does not reach React's root listener. */
function formSubmit(root: ParentNode) {
  const submit = root.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(submit?.form, "missing send button");
  const propsKey = Object.keys(submit.form).find((key) => key.startsWith("__reactProps"));
  const props = propsKey
    ? (submit.form as unknown as Record<string, { onSubmit?: (event: { preventDefault(): void }) => void }>)[propsKey]
    : undefined;
  assert.equal(typeof props?.onSubmit, "function", "reply form has no submit handler");
  props?.onSubmit?.({ preventDefault() {} });
}

function commandPosts(): CommandCall[] {
  return commandCalls.filter((call) => call.url.includes("/api/v2/commands"));
}

function lastReplyCommand(): { type?: string; all?: boolean; bodyHtml?: string; to?: string[] } {
  const call = commandPosts().at(-1);
  assert.ok(call, "no reply command was dispatched");
  const parsed = JSON.parse(call.body) as {
    command?: { type?: string; all?: boolean; bodyHtml?: string; to?: string[] };
  };
  return parsed.command ?? {};
}

async function mount(node: ReturnType<typeof createElement>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

await check("gmail reply sends the note to the spoofed message's mailbox, not its display name", async () => {
  const { provider, sends } = providerFor([trustedEarlier, spoofedLatest]);
  const conversation = await provider.getConversation("thr-spoof");
  const latest = conversation.messages.at(-1);
  assert.equal(latest?.providerMessageId, "m-spoof");
  assert.equal(latest?.from.name, "Pat Colleague");
  assert.equal(latest?.from.email, ATTACKER);
  assert.equal(conversation.messages[0].from.email, TRUSTED);
  assert.equal(conversation.messages[0].bodyText, EARLIER);

  await provider.reply(
    {
      conversationId: "thr-spoof",
      all: false,
      bodyHtml: `<p>${NOTE}</p><blockquote>${EARLIER}</blockquote>`,
    },
    "reply-key",
  );
  assert.equal(sends.length, 1);
  const to = addressesIn(headerValue(sends[0].raw, "To"));
  assert.deepEqual(to, [ATTACKER]);
  assert.ok(!to.includes(TRUSTED), "display-name mailbox must not replace the real one");
  assert.match(sends[0].raw, /Please wire the retainer/);
  assert.match(sends[0].raw, /88421/, "a reply that quotes the thread carries that text to the real mailbox");
  assert.equal(sends[0].threadId, "thr-spoof");
});

await check("gmail reply-all addresses every mailbox on the newest message except the user", async () => {
  const { provider, sends } = providerFor([trustedEarlier, spoofedLatest]);
  await provider.reply(
    { conversationId: "thr-spoof", all: true, bodyHtml: `<p>${NOTE}</p>` },
    "reply-all-key",
  );
  const to = addressesIn(headerValue(sends[0].raw, "To"));
  assert.ok(to.includes(ATTACKER));
  assert.ok(to.includes(SPY));
  assert.ok(!to.includes(USER));
  assert.ok(!to.some((address) => address.includes("pat colleague") || address === "finance"));
  assert.match(sends[0].raw, new RegExp(NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

await check("gmail does not let an email inside the display name become the recipient", async () => {
  const { provider, sends } = providerFor([embeddedName]);
  const conversation = await provider.getConversation("thr-spoof");
  const latest = conversation.messages.at(-1);
  assert.equal(latest?.from.email, ATTACKER);
  assert.match(latest?.from.name ?? "", new RegExp(TRUSTED, "i"));
  const cc = latest?.cc[0];
  assert.equal(cc?.email, SPY);
  assert.match(cc?.name ?? "", /payroll@company\.example/i);

  await provider.reply(
    { conversationId: "thr-spoof", all: true, bodyHtml: `<p>${NOTE}</p>` },
    "embedded-key",
  );
  const to = addressesIn(headerValue(sends[0].raw, "To"));
  assert.ok(to.includes(ATTACKER));
  assert.ok(to.includes(SPY));
  assert.ok(!to.includes(TRUSTED));
  assert.ok(!to.includes("payroll@company.example"));
});

await check("reading pane and reply bar show the mailbox beside the display name", async () => {
  const { provider } = providerFor([trustedEarlier, internalNote, spoofedLatest]);
  const conversation = await provider.getConversation("thr-spoof");
  const reader = renderReader(conversation, "reply");
  const turnNames = elementText(reader, "reader-turn-who");
  assert.ok(turnNames.length >= 2, `both external turns render, got ${JSON.stringify(turnNames)}`);
  assert.match(turnNames[0], /Pat Colleague/);
  assertShowsMailbox(turnNames[0], TRUSTED, "earlier turn");
  assert.match(turnNames.at(-1) ?? "", /Pat Colleague/);
  assertShowsMailbox(turnNames.at(-1) ?? "", ATTACKER, "newest turn");
  const branch = elementText(reader, "reader-branch-from").join(" ");
  assert.match(branch, /Sam Internal/);
  assertShowsMailbox(branch, INTERNAL, "internal branch");
  const banner = elementText(reader, "reader-ball").join(" ");
  assertShowsMailbox(banner, ATTACKER, "waiting-on banner");
  const reply = visibleReply(reader);
  assert.match(reply, /Pat Colleague/);
  assertShowsMailbox(reply, ATTACKER, "reply bar");
  assert.doesNotMatch(
    reply.replace(new RegExp(ATTACKER, "gi"), ""),
    new RegExp(TRUSTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    "reply bar must not present the trusted mailbox as the recipient",
  );
});

await check("reply-all bar lists every mailbox the provider will address", async () => {
  const { provider } = providerFor([trustedEarlier, spoofedLatest]);
  const conversation = await provider.getConversation("thr-spoof");
  const reply = visibleReply(renderReply(conversation, "replyAll"));
  assertShowsMailbox(reply, ATTACKER, "reply-all bar");
  assertShowsMailbox(reply, SPY, "reply-all bar");
  assert.match(reply, /Pat Colleague/);
  assert.match(reply, /Finance/);
});

await check("expanded reply shows the mailbox before send", async () => {
  const { provider } = providerFor([trustedEarlier, spoofedLatest]);
  const conversation = await provider.getConversation("thr-spoof");
  const html = renderToStaticMarkup(
    createElement(ComposePane, {
      intent: { mode: "reply" },
      providerConversationId: conversation.providerConversationId,
      preview: {
        ...conversation,
        messages: conversation.messages.map((message) => ({ ...message, bodyHtml: null })),
      },
      previewProvider: "google",
      onClose: () => {},
      onSent: () => {},
    }),
  );
  assert.doesNotMatch(html, /mail-recipient/, "reply stays without a free-typed To field");
  assertShowsMailbox(html.replace(/<[^>]+>/g, " "), ATTACKER, "expanded reply");
  const all = renderToStaticMarkup(
    createElement(ComposePane, {
      intent: { mode: "replyAll" },
      providerConversationId: conversation.providerConversationId,
      preview: {
        ...conversation,
        messages: conversation.messages.map((message) => ({ ...message, bodyHtml: null })),
      },
      previewProvider: "google",
      onClose: () => {},
      onSent: () => {},
    }),
  );
  const text = all.replace(/<[^>]+>/g, " ");
  assertShowsMailbox(text, ATTACKER, "expanded reply-all");
  assertShowsMailbox(text, SPY, "expanded reply-all");
});

await check("inbox row shows the mailbox beside a spoofed display name", async () => {
  const label = mailboxListLabel({
    latestOutgoing: false,
    fromName: "Pat Colleague",
    fromEmail: ATTACKER,
  });
  assert.match(label, /Pat Colleague/);
  assertShowsMailbox(label, ATTACKER, "inbox row");
});

await check("a display name that is a different mailbox cannot send without naming the real one", async () => {
  const { provider } = providerFor([embeddedName]);
  const conversation = await provider.getConversation("thr-spoof");
  const html = renderReply(conversation, "reply");
  const context = visibleReply(html);
  const alert = html.match(/role="alert"[^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, " ") ?? "";

  commandCalls.length = 0;
  const mounted = await mount(
    createElement(InlineReply, {
      conversation,
      providerConversationId: conversation.providerConversationId,
      accountId: "acct-1",
      intent: { mode: "reply" },
      onActivate: () => {},
      onClose: () => {},
      onExpand: () => {},
      onSent: () => {},
    }),
  );
  try {
    await fillComposer(mounted.container, NOTE);
    const before = commandPosts().length;
    const submit = mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    assert.ok(submit, "missing send button");
    await act(async () => {
      formSubmit(mounted.container);
    });
    await flush();
    assert.equal(
      commandPosts().length,
      before,
      `reply was dispatched before the user confirmed the real mailbox: ${commandPosts()
        .map((call) => call.body)
        .join(" | ")}`,
    );
    const confirmers = [...mounted.container.querySelectorAll("button, input")].filter(
      (element) =>
        element !== submit && controlName(element).toLowerCase().includes(ATTACKER),
    );
    assert.ok(
      confirmers.length > 0,
      "confirmation control must name the mailbox the reply will use",
    );
    await act(async () => {
      for (const element of confirmers) {
        if (element instanceof window.HTMLInputElement && element.type === "checkbox") {
          element.checked = true;
          element.dispatchEvent(new window.Event("change", { bubbles: true }));
        }
        (element as HTMLElement).click();
      }
    });
    await flush();
    if (commandPosts().length === before) {
      await act(async () => {
        formSubmit(mounted.container);
      });
      await flush();
    }
    const command = lastReplyCommand();
    assert.equal(command.type, "reply");
    assert.equal(command.all, false);
    assert.match(command.bodyHtml ?? "", /retainer/);
    for (const recipient of command.to ?? []) {
      assert.notEqual(recipient.toLowerCase(), TRUSTED);
      assert.equal(recipient.toLowerCase(), ATTACKER);
    }
  } finally {
    mounted.unmount();
  }
  assertShowsMailbox(context, ATTACKER, "reply bar");
  assert.match(html, /role="alert"/);
  assertShowsMailbox(alert, ATTACKER, "mismatch warning");
  assert.match(alert, new RegExp(TRUSTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

await check("reply-all also holds a cc display name that embeds a different mailbox", async () => {
  const { provider } = providerFor([embeddedName]);
  const conversation = await provider.getConversation("thr-spoof");
  const html = renderReply(conversation, "replyAll");
  const context = visibleReply(html);
  const alert = html.match(/role="alert"[^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, " ") ?? "";

  commandCalls.length = 0;
  const mounted = await mount(
    createElement(InlineReply, {
      conversation,
      providerConversationId: conversation.providerConversationId,
      accountId: "acct-1",
      intent: { mode: "replyAll" },
      onActivate: () => {},
      onClose: () => {},
      onExpand: () => {},
      onSent: () => {},
    }),
  );
  try {
    await fillComposer(mounted.container, NOTE);
    const before = commandPosts().length;
    const submit = mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    assert.ok(submit);
    await act(async () => {
      formSubmit(mounted.container);
    });
    await flush();
    assert.equal(
      commandPosts().length,
      before,
      `reply-all dispatched before confirmation: ${commandPosts()
        .map((call) => call.body)
        .join(" | ")}`,
    );
    const confirmers = [...mounted.container.querySelectorAll("button, input")].filter((element) => {
      const name = controlName(element).toLowerCase();
      return element !== submit && name.includes(ATTACKER) && name.includes(SPY);
    });
    assert.ok(
      confirmers.length > 0,
      "confirmation must name both mailboxes the reply-all will use",
    );
    await act(async () => {
      for (const element of confirmers) {
        if (element instanceof window.HTMLInputElement && element.type === "checkbox") {
          element.checked = true;
          element.dispatchEvent(new window.Event("change", { bubbles: true }));
        }
        (element as HTMLElement).click();
      }
    });
    await flush();
    if (commandPosts().length === before) {
      await act(async () => {
        formSubmit(mounted.container);
      });
      await flush();
    }
    const command = lastReplyCommand();
    assert.equal(command.type, "reply");
    assert.equal(command.all, true);
    for (const recipient of command.to ?? []) {
      const mailbox = recipient.toLowerCase();
      assert.notEqual(mailbox, TRUSTED);
      assert.notEqual(mailbox, "payroll@company.example");
    }
  } finally {
    mounted.unmount();
  }
  assertShowsMailbox(context, ATTACKER, "reply-all bar");
  assertShowsMailbox(context, SPY, "reply-all bar");
  assert.match(html, /role="alert"/);
  assertShowsMailbox(alert, SPY, "cc mismatch warning");
  assert.match(alert, /payroll@company\.example/i);
});

await check("expanded reply also sends before the real mailbox is confirmed", async () => {
  const { provider } = providerFor([embeddedName]);
  const conversation = await provider.getConversation("thr-spoof");
  const preview = {
    ...conversation,
    messages: conversation.messages.map((message) => ({ ...message, bodyHtml: null })),
  };
  commandCalls.length = 0;
  const mounted = await mount(
    createElement(ComposePane, {
      intent: { mode: "reply" },
      providerConversationId: conversation.providerConversationId,
      preview,
      previewProvider: "google",
      onClose: () => {},
      onSent: () => {},
    }),
  );
  try {
    await fillComposer(mounted.container, NOTE);
    const before = commandPosts().length;
    await act(async () => {
      formSubmit(mounted.container);
    });
    await flush();
    assert.equal(
      commandPosts().length,
      before,
      `expanded reply dispatched before confirmation: ${commandPosts()
        .map((call) => call.body)
        .join(" | ")}`,
    );
    const submit = mounted.container.querySelector("button[type='submit']");
    const confirmers = [...mounted.container.querySelectorAll("button, input")].filter(
      (element) => element !== submit && controlName(element).toLowerCase().includes(ATTACKER),
    );
    assert.ok(confirmers.length > 0, "expanded reply confirmation must name the real mailbox");
  } finally {
    mounted.unmount();
  }
});

await check("a bare mailbox with no display name still sends and shows that mailbox", async () => {
  const { provider } = providerFor([
    gmailMessage("m-bare", now, ATTACKER, "hello"),
  ]);
  const conversation = await provider.getConversation("thr-spoof");
  assert.equal(conversation.messages[0].from.email, ATTACKER);
  assert.equal(conversation.messages[0].from.name ?? "", "");
  const reply = visibleReply(renderReply(conversation, "reply"));
  assertShowsMailbox(reply, ATTACKER, "unnamed sender reply bar");
  const reader = renderReader(conversation, null);
  const turn = elementText(reader, "reader-turn-who").join(" ");
  assertShowsMailbox(turn, ATTACKER, "unnamed sender reading pane");
  assert.match(turn, /attacker/i);
});

function graphMessage(input: {
  id: string;
  when: string;
  name: string;
  address: string;
  cc?: { name: string; address: string }[];
  body: string;
}) {
  return {
    id: input.id,
    conversationId: "conv-spoof",
    subject: "Retainer",
    from: { emailAddress: { name: input.name, address: input.address } },
    toRecipients: [{ emailAddress: { name: "User", address: USER } }],
    ccRecipients: (input.cc ?? []).map((recipient) => ({
      emailAddress: { name: recipient.name, address: recipient.address },
    })),
    receivedDateTime: input.when,
    bodyPreview: input.body.slice(0, 80),
    body: { contentType: "text", content: input.body },
    isRead: false,
    hasAttachments: false,
  };
}

await check("outlook reply posts the note to the spoofed message, not the display name", async () => {
  const older = graphMessage({
    id: "graph-old",
    when: new Date(now - 86_400_000).toISOString(),
    name: "Pat Colleague",
    address: TRUSTED,
    body: EARLIER,
  });
  const newest = graphMessage({
    id: "graph-new",
    when: new Date(now).toISOString(),
    name: "Pat Colleague",
    address: ATTACKER,
    cc: [{ name: "Finance", address: SPY }],
    body: "Can you send that over?",
  });
  // Graph page order is oldest first here, which is the order this adapter
  // treats as "last". The selected message is the spoofed one.
  const messages = [older, newest];
  const replies: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("conversationId")) {
      return new Response(JSON.stringify({ value: messages }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && /\/messages\/[^/]+\/reply(All)?$/.test(href)) {
      replies.push({ url: href, body: String(init?.body ?? "") });
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected outlook request ${method} ${href}`);
  }) as typeof fetch;
  const provider = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: USER,
    fetchImpl,
  });
  const conversation = await provider.getConversation("conv-spoof");
  const latest = conversation.messages.at(-1);
  assert.equal(latest?.from.name, "Pat Colleague");
  assert.equal(latest?.from.email, ATTACKER);
  assert.equal(latest?.providerMessageId, "graph-new");
  assert.equal(conversation.messages[0].bodyText, EARLIER);

  await provider.reply(
    { conversationId: "conv-spoof", all: false, bodyHtml: `<p>${NOTE}</p>` },
    "outlook-reply",
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0].url, /\/messages\/graph-new\/reply$/);
  const payload = JSON.parse(replies[0].body) as {
    comment?: string;
    message?: { toRecipients?: { emailAddress?: { address?: string; name?: string } }[] };
  };
  assert.match(payload.comment ?? "", /retainer/);
  const named = JSON.stringify(payload);
  assert.ok(!named.toLowerCase().includes(TRUSTED), "display-name mailbox must not be the recipient");
  for (const recipient of payload.message?.toRecipients ?? []) {
    assert.equal(recipient.emailAddress?.address?.toLowerCase(), ATTACKER);
    assert.notEqual(recipient.emailAddress?.name, "Pat Colleague");
  }

  await provider.reply(
    { conversationId: "conv-spoof", all: true, bodyHtml: `<p>${NOTE}</p>` },
    "outlook-reply-all",
  );
  assert.match(replies[1].url, /\/messages\/graph-new\/replyAll$/);

  const reader = renderReader(conversation, "reply");
  const newestTurn = elementText(reader, "reader-turn-who").at(-1) ?? "";
  assert.match(newestTurn, /Pat Colleague/);
  assertShowsMailbox(newestTurn, ATTACKER, "outlook reading pane");
  assertShowsMailbox(visibleReply(reader), ATTACKER, "outlook reply bar");
  const replyAllBar = visibleReply(renderReply(conversation, "replyAll"));
  assertShowsMailbox(replyAllBar, ATTACKER, "outlook reply-all bar");
  assertShowsMailbox(replyAllBar, SPY, "outlook reply-all bar");
});

await check("outlook display name that embeds another mailbox is not who is replied to", async () => {
  const message = graphMessage({
    id: "graph-embedded",
    when: new Date(now).toISOString(),
    name: TRUSTED,
    address: ATTACKER,
    cc: [{ name: "payroll@company.example", address: SPY }],
    body: "Use my other address.",
  });
  const replies: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("conversationId")) {
      return new Response(JSON.stringify({ value: [message] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && /\/reply(All)?$/.test(href)) {
      replies.push({ url: href, body: String(init?.body ?? "") });
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected outlook request ${method} ${href}`);
  }) as typeof fetch;
  const provider = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: USER,
    fetchImpl,
  });
  const conversation = await provider.getConversation("conv-spoof");
  assert.equal(conversation.messages[0].from.email, ATTACKER);
  assert.equal(conversation.messages[0].from.name, TRUSTED);
  await provider.reply(
    { conversationId: "conv-spoof", all: false, bodyHtml: `<p>${NOTE}</p>` },
    "outlook-embedded",
  );
  assert.match(replies[0].url, /\/messages\/graph-embedded\/reply$/);
  assert.equal(JSON.parse(replies[0].body).comment.includes("retainer"), true);
  const html = renderReply(conversation, "reply");
  assertShowsMailbox(visibleReply(html), ATTACKER, "outlook embedded-name reply bar");
  assert.match(html, /role="alert"/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log("\nspoofed-sender-reply: OK");
}
