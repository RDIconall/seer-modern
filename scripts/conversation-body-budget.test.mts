/**
 * Spec for the Outlook conversation-download denial of service.
 *
 * Opening one message must not pull an entire conversation's bodies into
 * memory at once. These assertions fail while that download is unbounded
 * and pass once a read loads a small page, keeps only a capped prefix of
 * each body, and never holds more than that page of bodies at the same time.
 *
 * The Microsoft Graph and Gmail HTTP APIs are stood in here. The stand-in
 * only returns the JSON shapes the client already parses; the product code
 * performs every later step (list, parallel fetch, parse, retain, respond).
 *
 * Covered:
 * - getGraphConversationMessages (src/lib/mail/graph.ts)
 * - GET /api/messages/[id] for a Microsoft session (src/app/api/messages/[id]/route.ts)
 * - OutlookProvider getConversation, syncFolder, reply, forward,
 *   moveConversation, mutateConversation
 * - getGmailThreadMessages (same route, Google branch)
 * - GmailProvider getConversation, syncFolder, reply, forward, mutateConversation
 *
 * Not covered, and why:
 * - graphThreadAction lists ids and does not download bodies.
 * - GmailProvider.moveConversation asks for format=minimal and does not download bodies.
 * - OutlookProvider.search and GmailProvider.search return one result page, not a
 *   walked conversation. Callers that later page those cursors are not this test.
 * - getGraphAttachment / GmailProvider.getAttachment download one file, not the conversation.
 * - getCorpusConversation (src/lib/v3/reader/repository.ts) selects every stored
 *   body_html and body_text for the conversation with no limit. It does not call
 *   Graph. The embedded Postgres test binary in this environment does not start
 *   (it needs libicuuc.so.60), so that read was not executed.
 */
import assert from "node:assert/strict";
import { getGraphConversationMessages } from "../src/lib/mail/graph.ts";
import { getGmailThreadMessages } from "../src/lib/mail/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const MAX_MESSAGES = 20;
const MAX_RETAINED_BODY_CHARS = 32_768;
const MESSAGE_COUNT = 60;
const TEXT = "A".repeat(50_000);
const HTML = `<p>${TEXT}</p>`;
const CONVERSATION_ID = "conv-1";
const TOKEN = "access-token-placeholder";

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  receivedDateTime: string;
  sentDateTime: string;
  isRead: boolean;
  hasAttachments: boolean;
  parentFolderId: string;
  from: { emailAddress: { name: string; address: string } };
  toRecipients: { emailAddress: { address: string } }[];
  ccRecipients: [];
  internetMessageId: string;
};

const messages: GraphMessage[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => {
  const receivedDateTime = new Date(Date.UTC(2026, 7, 1, 0, i, 0)).toISOString();
  return {
    id: `m-${i}`,
    conversationId: CONVERSATION_ID,
    subject: "Quarterly packet",
    bodyPreview: "preview",
    body: { contentType: "html", content: HTML },
    receivedDateTime,
    sentDateTime: receivedDateTime,
    isRead: false,
    hasAttachments: false,
    parentFolderId: "inbox",
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { address: "owner@rditrials.com" } }],
    ccRecipients: [],
    internetMessageId: `<m-${i}@example.com>`,
  };
});

type Tracker = {
  inflight: number;
  peak: number;
  total: number;
  urls: string[];
};

function newTracker(): Tracker {
  return { inflight: 0, peak: 0, total: 0, urls: [] };
}

function selectIncludesBody(select: string): boolean {
  return select.split(",").some((part) => part.trim().toLowerCase() === "body");
}

function countBodies(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const record = payload as {
    value?: { body?: { content?: string } }[];
    body?: { content?: string };
    messages?: { payload?: { body?: { data?: string }; parts?: unknown[] } }[];
    payload?: { body?: { data?: string }; parts?: unknown[] };
  };
  if (Array.isArray(record.value)) {
    return record.value.filter((item) => (item.body?.content?.length ?? 0) > 0).length;
  }
  if ((record.body?.content?.length ?? 0) > 0) return 1;
  if (Array.isArray(record.messages)) {
    return record.messages.filter((item) => gmailPayloadHasBody(item.payload)).length;
  }
  if (gmailPayloadHasBody(record.payload)) return 1;
  return 0;
}

function gmailPayloadHasBody(
  payload: { body?: { data?: string }; parts?: unknown[] } | undefined,
): boolean {
  return Boolean(payload?.body?.data) || Boolean(payload?.parts?.length);
}

function trackedResponse(payload: unknown, tracker: Tracker): Response {
  const bodies = countBodies(payload);
  const raw = JSON.stringify(payload);
  const response = new Response(raw, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  let charged = false;
  const charge = async () => {
    if (charged || bodies === 0) return;
    charged = true;
    tracker.inflight += bodies;
    tracker.peak = Math.max(tracker.peak, tracker.inflight);
    tracker.total += bodies;
    await new Promise((resolve) => setTimeout(resolve, 20));
    tracker.inflight -= bodies;
  };
  const text = response.text.bind(response);
  const json = response.json.bind(response);
  response.text = async () => {
    await charge();
    return text();
  };
  response.json = async () => {
    await charge();
    return json();
  };
  return response;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage(id: string) {
  const message = messages.find((item) => item.id === id) ?? messages[0];
  return {
    id,
    threadId: CONVERSATION_ID,
    snippet: "preview",
    internalDate: String(Date.parse(message.receivedDateTime)),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "owner@rditrials.com" },
        { name: "Subject", value: "Quarterly packet" },
        { name: "Message-ID", value: `<${id}@example.com>` },
      ],
      body: { size: HTML.length, data: base64Url(HTML) },
    },
  };
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    return new URL(raw.replace(/ /g, "%20"));
  }
}

function graphPayload(url: URL): unknown {
  const top = Number(url.searchParams.get("$top") ?? "0");
  const select = url.searchParams.get("$select") ?? "";
  const page = Number(url.searchParams.get("conversationPage") ?? "0");
  const filter = url.searchParams.get("$filter") ?? "";
  const path = url.pathname;

  if (path.endsWith("/mailFolders/inbox") && !path.endsWith("/messages")) {
    return { totalItemCount: MESSAGE_COUNT };
  }
  if (path.includes("/mailFolders/") && path.endsWith("/messages")) {
    const first = messages[0];
    return {
      value: [
        {
          id: first.id,
          conversationId: first.conversationId,
          subject: first.subject,
          bodyPreview: first.bodyPreview,
          receivedDateTime: first.receivedDateTime,
          isRead: false,
          from: first.from,
          toRecipients: first.toRecipients,
        },
      ],
    };
  }

  const one = path.match(/\/messages\/([^/]+)$/);
  if (one) {
    const message = messages.find((item) => item.id === decodeURIComponent(one[1]));
    if (!message) return { error: { code: "ErrorItemNotFound" } };
    if (!selectIncludesBody(select)) {
      const { body: _body, ...withoutBody } = message;
      return withoutBody;
    }
    return message;
  }

  const queryingConversation =
    filter.includes("conversationId") || url.searchParams.has("conversationPage");
  if (path.endsWith("/messages") && queryingConversation) {
    const pageSize = top > 0 ? top : 50;
    const slice = messages.slice(page, page + pageSize);
    const value = selectIncludesBody(select)
      ? slice
      : slice.map((message) => ({ id: message.id }));
    const next =
      page + pageSize < messages.length
        ? `https://graph.microsoft.com/v1.0/me/messages?conversationPage=${page + pageSize}&$top=${pageSize}&$select=${encodeURIComponent(select)}&$filter=${encodeURIComponent("conversationId eq 'conv-1'")}`
        : undefined;
    return next ? { value, "@odata.nextLink": next } : { value };
  }

  return { value: [] };
}

function gmailPayload(url: URL): unknown {
  const path = url.pathname;
  if (path.endsWith("/threads")) {
    return { threads: [{ id: CONVERSATION_ID }], resultSizeEstimate: 1 };
  }
  const thread = path.match(/\/threads\/([^/]+)$/);
  if (thread) {
    if (url.searchParams.get("format") === "minimal") {
      return {
        id: CONVERSATION_ID,
        messages: messages.map((message) => ({ id: message.id })),
      };
    }
    return {
      id: CONVERSATION_ID,
      messages: messages.map((message) => gmailMessage(message.id)),
    };
  }
  const one = path.match(/\/messages\/([^/]+)$/);
  if (one) return gmailMessage(decodeURIComponent(one[1]));
  return {};
}

function installFetch(tracker: Tracker): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    tracker.urls.push(`${method} ${raw}`);
    if (method !== "GET" && method !== "HEAD") {
      return trackedResponse({}, tracker);
    }
    const url = parseUrl(raw);
    if (url.hostname === "gmail.googleapis.com") {
      return trackedResponse(gmailPayload(url), tracker);
    }
    if (url.hostname === "graph.microsoft.com") {
      const payload = graphPayload(url);
      if (
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        url.pathname.match(/\/messages\/[^/]+$/)
      ) {
        return new Response(JSON.stringify(payload), { status: 404 });
      }
      return trackedResponse(payload, tracker);
    }
    throw new Error(`unexpected fetch ${method} ${raw}`);
  };
}

const failures: string[] = [];

function expect(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

function keptBody(html: string | null | undefined, text: string | null | undefined): string {
  const htmlBody = html ?? "";
  const textBody = text ?? "";
  return htmlBody.length >= textBody.length ? htmlBody : textBody;
}

function expectCappedBodies(
  label: string,
  bodies: { html: string | null | undefined; text: string | null | undefined }[],
  tracker: Tracker,
  readBudget: number,
) {
  expect(
    bodies.length > 0,
    `${label}: returned no messages, so the read did not keep a capped page of the conversation`,
  );
  expect(
    bodies.length <= MAX_MESSAGES,
    `${label}: returned ${bodies.length} messages; a read may keep at most ${MAX_MESSAGES}`,
  );
  let overCap = 0;
  let longest = 0;
  for (const body of bodies) {
    const kept = keptBody(body.html, body.text);
    const sample = kept.slice(0, 64);
    expect(
      kept.length > 0 && (HTML.startsWith(sample) || TEXT.startsWith(sample)),
      `${label}: kept ${JSON.stringify(sample)} which is not the start of the delivered body`,
    );
    if (kept.length > MAX_RETAINED_BODY_CHARS) {
      overCap += 1;
      longest = Math.max(longest, kept.length);
    }
  }
  expect(
    overCap === 0,
    `${label}: ${overCap} messages kept more than ${MAX_RETAINED_BODY_CHARS} characters (longest ${longest})`,
  );
  expect(
    tracker.total <= readBudget,
    `${label}: read ${tracker.total} message bodies from the provider; budget is ${readBudget}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `${label}: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
}

async function withFetch<T>(tracker: Tracker, run: (fetchImpl: typeof fetch) => Promise<T>): Promise<T> {
  const fetchImpl = installFetch(tracker);
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run(fetchImpl);
  } finally {
    globalThis.fetch = previous;
  }
}

async function check(label: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: threw before the budget could be checked (${message})`);
  }
}

await check("getGraphConversationMessages", async () => {
  const tracker = newTracker();
  const thread = await withFetch(tracker, () =>
    getGraphConversationMessages(TOKEN, CONVERSATION_ID),
  );
  expectCappedBodies(
    "getGraphConversationMessages",
    thread.map((message) => ({ html: message.htmlBody, text: message.textBody })),
    tracker,
    MAX_MESSAGES,
  );
});

await check("getGmailThreadMessages", async () => {
  const tracker = newTracker();
  const thread = await withFetch(tracker, () =>
    getGmailThreadMessages(TOKEN, CONVERSATION_ID),
  );
  expectCappedBodies(
    "getGmailThreadMessages",
    thread.map((message) => ({ html: message.htmlBody, text: message.textBody })),
    tracker,
    MAX_MESSAGES,
  );
});

function outlook(fetchImpl: typeof fetch) {
  return new OutlookProvider({
    accessToken: TOKEN,
    accountEmail: "owner@rditrials.com",
    fetchImpl,
  });
}

function gmail(fetchImpl: typeof fetch) {
  return new GmailProvider({
    accessToken: TOKEN,
    accountEmail: "owner@rditrials.com",
    fetchImpl,
  });
}

await check("OutlookProvider.getConversation", async () => {
  const tracker = newTracker();
  const conversation = await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).getConversation(CONVERSATION_ID),
  );
  expectCappedBodies(
    "OutlookProvider.getConversation",
    conversation.messages.map((message) => ({
      html: message.bodyHtml,
      text: message.bodyText,
    })),
    tracker,
    MAX_MESSAGES,
  );
});

await check("OutlookProvider.syncFolder", async () => {
  const tracker = newTracker();
  const page = await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).syncFolder("inbox"),
  );
  const bodies = page.conversations.flatMap((conversation) =>
    conversation.messages.map((message) => ({
      html: message.bodyHtml,
      text: message.bodyText,
    })),
  );
  expectCappedBodies("OutlookProvider.syncFolder", bodies, tracker, MAX_MESSAGES);
});

await check("OutlookProvider.reply", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).reply(
      { conversationId: CONVERSATION_ID, all: false, bodyHtml: "<p>ok</p>" },
      "reply-key",
    ),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `OutlookProvider.reply: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `OutlookProvider.reply: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("OutlookProvider.forward", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).forward(
      {
        conversationId: CONVERSATION_ID,
        to: [{ email: "other@example.com" }],
        bodyHtml: "<p>ok</p>",
      },
      "forward-key",
    ),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `OutlookProvider.forward: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `OutlookProvider.forward: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("OutlookProvider.moveConversation", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).moveConversation(CONVERSATION_ID, "archive", "move-key"),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `OutlookProvider.moveConversation: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `OutlookProvider.moveConversation: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("OutlookProvider.mutateConversation", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    outlook(fetchImpl).mutateConversation(CONVERSATION_ID, "archive", "mutate-key"),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `OutlookProvider.mutateConversation: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `OutlookProvider.mutateConversation: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("GmailProvider.getConversation", async () => {
  const tracker = newTracker();
  const conversation = await withFetch(tracker, (fetchImpl) =>
    gmail(fetchImpl).getConversation(CONVERSATION_ID),
  );
  expectCappedBodies(
    "GmailProvider.getConversation",
    conversation.messages.map((message) => ({
      html: message.bodyHtml,
      text: message.bodyText,
    })),
    tracker,
    MAX_MESSAGES,
  );
});

await check("GmailProvider.syncFolder", async () => {
  const tracker = newTracker();
  const page = await withFetch(tracker, (fetchImpl) => gmail(fetchImpl).syncFolder("inbox"));
  const bodies = page.conversations.flatMap((conversation) =>
    conversation.messages.map((message) => ({
      html: message.bodyHtml,
      text: message.bodyText,
    })),
  );
  expectCappedBodies("GmailProvider.syncFolder", bodies, tracker, MAX_MESSAGES);
});

await check("GmailProvider.reply", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    gmail(fetchImpl).reply(
      { conversationId: CONVERSATION_ID, all: false, bodyHtml: "<p>ok</p>" },
      "reply-key",
    ),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `GmailProvider.reply: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `GmailProvider.reply: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("GmailProvider.forward", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    gmail(fetchImpl).forward(
      {
        conversationId: CONVERSATION_ID,
        to: [{ email: "other@example.com" }],
        bodyHtml: "<p>ok</p>",
      },
      "forward-key",
    ),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `GmailProvider.forward: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `GmailProvider.forward: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("GmailProvider.mutateConversation", async () => {
  const tracker = newTracker();
  await withFetch(tracker, (fetchImpl) =>
    gmail(fetchImpl).mutateConversation(CONVERSATION_ID, "archive", "mutate-key"),
  );
  expect(
    tracker.total <= MAX_MESSAGES,
    `GmailProvider.mutateConversation: read ${tracker.total} message bodies; budget is ${MAX_MESSAGES}`,
  );
  expect(
    tracker.peak <= MAX_MESSAGES,
    `GmailProvider.mutateConversation: held ${tracker.peak} message bodies at once; limit is ${MAX_MESSAGES}`,
  );
});

await check("GET /api/messages/[id]", async () => {
  const tracker = newTracker();
  const route = await import("../src/app/api/messages/[id]/route.ts");
  const response = await withFetch(tracker, () =>
    route.GET(new Request("http://localhost/api/messages/m-0"), {
      params: Promise.resolve({ id: "m-0" }),
    }),
  );
  const payload = (await response.json()) as {
    error?: string;
    message?: { htmlBody?: string; textBody?: string };
    thread?: { htmlBody?: string; textBody?: string }[];
  };
  expect(
    response.status === 200,
    `GET /api/messages/[id]: status ${response.status} ${payload.error ?? ""}`,
  );
  if (response.status !== 200 || !payload.thread || !payload.message) return;
  expectCappedBodies(
    "GET /api/messages/[id] thread",
    payload.thread.map((message) => ({ html: message.htmlBody, text: message.textBody })),
    tracker,
    MAX_MESSAGES + 1,
  );
  const opened = keptBody(payload.message.htmlBody, payload.message.textBody);
  expect(
    opened.length <= MAX_RETAINED_BODY_CHARS &&
      opened.length > 0 &&
      (HTML.startsWith(opened) || TEXT.startsWith(opened)),
    `GET /api/messages/[id]: opened message kept ${opened.length} characters`,
  );
});

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

assert.ok(HTML.length > MAX_RETAINED_BODY_CHARS);
console.log("conversation-body-budget: OK");
