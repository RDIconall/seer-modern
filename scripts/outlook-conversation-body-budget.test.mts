/**
 * Spec for the Outlook conversation-read denial of service.
 *
 * Opening one conversation must not download every full message body at once.
 * These assertions fail while that behavior is present and pass once a read
 * keeps a bounded page, fetches bodies in a small batch, and caps the bytes
 * retained from each message.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/outlook-conversation-body-budget.test.mts
 *
 * The Graph stand-in follows Microsoft Graph v1.0: `$select` returns only the
 * named properties (learn.microsoft.com graph query-parameters, Select), and
 * `message.body` is the item body (message resource). A message read with no
 * `$select` includes `body`, matching a get that does not narrow properties.
 * The Gmail stand-in follows users.threads.get / users.messages.get: `format=full`
 * carries the parsed body and `format=minimal` or `format=metadata` does not
 * (developers.google.com/gmail/api/reference/rest/v1/users.threads/get).
 * Exchange threads replies that share In-Reply-To / References into one
 * conversation (learn.microsoft.com EWS "Work with conversations"). This file
 * starts at the Graph/Gmail HTTP response those messages become.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-body-budget-"));
delete process.env.POSTGRES_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

/** Bodies kept from one conversation read, in characters of message content. */
const CAP = 32_768;
/** How many capped bodies fit in one read. */
const PAGE = 8;
const BATCH = 8;
const BIG = 48_000;
const COUNT = 100;
const BIG_BODY = "A".repeat(BIG);
const SHORT_BODY = "<p>body</p>";

const sessionState: { provider: "microsoft-entra-id" | "google" } = {
  provider: "microsoft-entra-id",
};
const accountState: { current: unknown } = { current: null };

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => ({
      accessToken: "test-token",
      provider: sessionState.provider,
      email: "owner@example.com",
      name: "Owner",
      accountId: "acct-1",
    }),
  },
});

mock.module("@/lib/v2/session", {
  namedExports: {
    isV2Enabled: () => true,
    getActiveV2Account: async () => accountState.current,
  },
});

type Region = { start: number; end: number; scale: "raw" | "base64"; read: number };

const meter = {
  maxConcurrent: 0,
  inFlight: 0,
  regions: [] as Region[],
};

function resetMeter(): void {
  meter.maxConcurrent = 0;
  meter.inFlight = 0;
  meter.regions = [];
}

function decodedRead(region: Region): number {
  if (region.scale === "raw") return region.read;
  return Math.floor((region.read * 3) / 4);
}

type Fixture = { id: string; when: string; body: string; subject: string };

function series(prefix: string, body: string, count: number, subject: string): Fixture[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    when: new Date(Date.UTC(2026, 0, 1, 0, i % 60, Math.floor(i / 60))).toISOString(),
    body,
    subject,
  }));
}

const outlookBig = series("m-", BIG_BODY, COUNT, "Budget thread");
const outlookShort = series("s-", SHORT_BODY, 2, "Short thread");
const gmailBig = series("g-", BIG_BODY, COUNT, "Budget thread");
const gmailShort = series("gs-", SHORT_BODY, 2, "Short thread");

function selected(url: string): string[] | null {
  const select = new URL(url).searchParams.get("$select");
  if (select === null) return null;
  return select.split(",").map((part) => part.trim().toLowerCase());
}

function selects(url: string, prop: string): boolean {
  const props = selected(url);
  if (props === null) return false;
  return props.includes(prop.toLowerCase());
}

function gmailFormat(url: string): string | null {
  return new URL(url).searchParams.get("format");
}

function isGmailMessageRead(url: string): boolean {
  return /\/messages\/[^/?]+/.test(new URL(url).pathname);
}

function isGmailThreadRead(url: string): boolean {
  return /\/threads\/[^/?]+$/.test(new URL(url).pathname);
}

/** True when this GET asks the provider for message body content. */
function wantsBody(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.hostname === "gmail.googleapis.com") {
    const format = gmailFormat(url);
    if (format === "minimal" || format === "metadata") return false;
    if (format !== "full" && format !== null) return false;
    return isGmailMessageRead(url) || isGmailThreadRead(url);
  }
  if (parsed.hostname !== "graph.microsoft.com") return false;
  if (!/\/messages(\/|$)/.test(parsed.pathname)) return false;
  if (/\/(move|reply|replyAll|forward|attachments|sendMail)(\/|$)/.test(parsed.pathname)) {
    return false;
  }
  const props = selected(url);
  if (props === null) return true;
  return props.includes("body");
}

function locate(haystack: string, needle: string, count: number, scale: Region["scale"]): Region[] {
  const quoted = JSON.stringify(needle);
  const found: Region[] = [];
  let from = 0;
  for (let i = 0; i < count; i++) {
    const idx = haystack.indexOf(quoted, from);
    if (idx < 0) {
      throw new Error(`stand-in payload missing body ${i + 1} of ${count}`);
    }
    found.push({
      start: idx + 1,
      end: idx + quoted.length - 1,
      scale,
      read: 0,
    });
    from = idx + quoted.length;
  }
  return found;
}

function jsonResponse(body: unknown, regions: Region[], track: boolean): Response {
  const raw = JSON.stringify(body);
  for (const region of regions) meter.regions.push(region);
  const bytes = Buffer.from(raw);
  let offset = 0;
  let released = false;
  const release = () => {
    if (!track || released) return;
    released = true;
    meter.inFlight = Math.max(0, meter.inFlight - 1);
  };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        release();
        return;
      }
      const end = Math.min(offset + 4096, bytes.length);
      for (const region of regions) {
        const overlap = Math.min(end, region.end) - Math.max(offset, region.start);
        if (overlap > 0) region.read += overlap;
      }
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      release();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function graphMessage(fixture: Fixture, url: string): Record<string, unknown> {
  const message: Record<string, unknown> = {
    id: fixture.id,
    conversationId: "conv-1",
    subject: fixture.subject,
    receivedDateTime: fixture.when,
    sentDateTime: fixture.when,
    isRead: false,
    hasAttachments: false,
    parentFolderId: "inbox",
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { address: "owner@example.com" } }],
    ccRecipients: [],
    internetMessageId: `<${fixture.id}@attacker.example>`,
  };
  const props = selected(url);
  const preview = props === null || props.includes("bodypreview");
  const body = props === null || props.includes("body");
  if (preview) message.bodyPreview = fixture.body.slice(0, 255);
  if (body) message.body = { contentType: "html", content: fixture.body };
  return message;
}

function gmailMessage(fixture: Fixture, threadId: string): Record<string, unknown> {
  const data = Buffer.from(fixture.body, "utf8").toString("base64url");
  return {
    id: fixture.id,
    threadId,
    snippet: fixture.body.slice(0, 255),
    internalDate: String(Date.parse(fixture.when)),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: fixture.subject },
      ],
      parts: [
        {
          mimeType: "text/html",
          body: { size: fixture.body.length, data },
        },
      ],
    },
  };
}

function pageOf(all: Fixture[], url: string): { slice: Fixture[]; next: string | null } {
  const parsed = new URL(url);
  const top = Number(parsed.searchParams.get("$top") ?? "50");
  const page = Number(parsed.searchParams.get("page") ?? "1");
  const start = (page - 1) * top;
  const slice = all.slice(start, start + top);
  if (start + top >= all.length || slice.length === 0) return { slice, next: null };
  const nextUrl = new URL(url);
  nextUrl.searchParams.set("page", String(page + 1));
  return { slice, next: nextUrl.toString() };
}

function outlookFixtures(url: string): Fixture[] {
  const filter = new URL(url).searchParams.get("$filter") ?? "";
  if (filter.includes("conv-short")) return outlookShort;
  return outlookBig;
}

function gmailFixtures(threadId: string): Fixture[] {
  return threadId === "thread-short" ? gmailShort : gmailBig;
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (url.includes("gmail.googleapis.com") && url.includes("/messages/send")) {
      return emptyJson({ id: "sent", threadId: "thread-1" });
    }
    return new Response("", { status: 202 });
  }

  const parsed = new URL(url);
  const bodyRead = wantsBody(url);
  if (bodyRead) {
    meter.inFlight += 1;
    meter.maxConcurrent = Math.max(meter.maxConcurrent, meter.inFlight);
  }

  if (parsed.hostname === "graph.microsoft.com") {
    if (parsed.pathname.includes("/contacts")) return emptyJson({ value: [] });
    if (parsed.pathname.includes("/calendarView")) return emptyJson({ value: [] });
    if (parsed.pathname.includes("/mailFolders/") && parsed.pathname.endsWith("/messages")) {
      const fixture = outlookBig[0];
      return emptyJson({
        "@odata.count": 1,
        value: [graphMessage(fixture, url)],
      });
    }
    if (parsed.pathname.includes("/mailFolders/") && parsed.searchParams.has("$select")) {
      return emptyJson({ totalItemCount: 1, value: [] });
    }
    if (parsed.searchParams.has("$search")) {
      const top = Number(parsed.searchParams.get("$top") ?? "40");
      const slice = outlookBig.slice(0, top);
      const value = slice.map((item) => graphMessage(item, url));
      const payload = { value };
      const regions = bodyRead ? locate(JSON.stringify(payload), BIG_BODY, slice.length, "raw") : [];
      return jsonResponse(payload, regions, bodyRead);
    }
    if (parsed.searchParams.has("$filter") && parsed.searchParams.get("$filter")?.includes("conversationId")) {
      const all = outlookFixtures(url);
      if (!bodyRead) {
        return emptyJson({ value: all.slice(0, Number(parsed.searchParams.get("$top") ?? all.length)).map((item) => ({ id: item.id })) });
      }
      const { slice, next } = pageOf(all, url);
      const value = slice.map((item) => graphMessage(item, url));
      const payload = { value, ...(next ? { "@odata.nextLink": next } : {}) };
      const regions =
        bodyRead && slice[0]?.body === BIG_BODY
          ? locate(JSON.stringify(payload), BIG_BODY, slice.length, "raw")
          : [];
      return jsonResponse(payload, regions, bodyRead);
    }
    const one = parsed.pathname.match(/\/messages\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const fixture =
        outlookShort.find((item) => item.id === id) ??
        outlookBig.find((item) => item.id === id) ??
        outlookBig[0];
      const message = graphMessage(fixture, url);
      const regions =
        bodyRead && fixture.body === BIG_BODY ? locate(JSON.stringify(message), BIG_BODY, 1, "raw") : [];
      return jsonResponse(message, regions, bodyRead);
    }
    return emptyJson({ value: [] });
  }

  if (parsed.hostname === "gmail.googleapis.com") {
    if (parsed.pathname.includes("/threads") && !isGmailThreadRead(url)) {
      const threadId = parsed.searchParams.get("q")?.includes("short") ? "thread-short" : "thread-1";
      return emptyJson({ threads: [{ id: threadId }], resultSizeEstimate: 1 });
    }
    if (isGmailThreadRead(url)) {
      const threadId = decodeURIComponent(parsed.pathname.split("/").pop() ?? "thread-1");
      const all = gmailFixtures(threadId);
      if (!bodyRead) return emptyJson({ id: threadId, messages: all.map((item) => ({ id: item.id })) });
      const messages = all.map((item) => gmailMessage(item, threadId));
      const payload = { id: threadId, messages };
      const needle = Buffer.from(all[0].body, "utf8").toString("base64url");
      const regions =
        all[0].body === BIG_BODY ? locate(JSON.stringify(payload), needle, all.length, "base64") : [];
      return jsonResponse(payload, regions, bodyRead);
    }
    if (isGmailMessageRead(url)) {
      const id = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
      const fixture =
        gmailShort.find((item) => item.id === id) ??
        gmailBig.find((item) => item.id === id) ??
        gmailBig[0];
      const format = gmailFormat(url);
      if (format === "metadata" || format === "minimal") {
        return emptyJson({
          id: fixture.id,
          threadId: fixture.id.startsWith("gs-") ? "thread-short" : "thread-1",
          snippet: fixture.body.slice(0, 80),
          internalDate: String(Date.parse(fixture.when)),
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "Attacker <attacker@example.com>" },
              { name: "Subject", value: fixture.subject },
            ],
          },
        });
      }
      const threadId = fixture.id.startsWith("gs-") ? "thread-short" : "thread-1";
      const message = gmailMessage(fixture, threadId);
      const regions =
        fixture.body === BIG_BODY
          ? locate(JSON.stringify(message), Buffer.from(BIG_BODY, "utf8").toString("base64url"), 1, "base64")
          : [];
      return jsonResponse(message, regions, bodyRead);
    }
    if (parsed.pathname.includes("/messages")) return emptyJson({ messages: [] });
    if (parsed.pathname.includes("/labels/")) return emptyJson({ messagesTotal: 0, threadsTotal: 0 });
    return emptyJson({});
  }

  if (parsed.hostname === "people.googleapis.com") {
    return emptyJson({ connections: [], otherContacts: [] });
  }
  if (parsed.hostname === "www.googleapis.com") return emptyJson({ items: [] });
  if (parsed.hostname === "generativelanguage.googleapis.com") return emptyJson({ models: [] });
  return new Response("not found", { status: 404 });
};

globalThis.fetch = fetchImpl;

function budgetProblems(): string[] {
  const problems: string[] = [];
  if (meter.maxConcurrent > BATCH) {
    problems.push(`concurrent body reads ${meter.maxConcurrent} > ${BATCH}`);
  }
  let total = 0;
  let widest = 0;
  let overCap = 0;
  for (const region of meter.regions) {
    const chars = decodedRead(region);
    total += chars;
    widest = Math.max(widest, chars);
    if (chars > CAP) overCap += 1;
  }
  if (overCap > 0) problems.push(`${overCap} bodies delivered above ${CAP} chars (widest ${widest})`);
  if (total > PAGE * CAP) {
    problems.push(`conversation delivered ${total} body chars > ${PAGE * CAP}`);
  }
  if (problems.length > 0) {
    problems.push(`(concurrent ${meter.maxConcurrent}, regions ${meter.regions.length})`);
  }
  return problems;
}

function keptText(value: { htmlBody?: string | null; textBody?: string | null; bodyHtml?: string | null; bodyText?: string | null }): string {
  return value.htmlBody || value.textBody || value.bodyHtml || value.bodyText || "";
}

function assertKept(label: string, bodies: string[], big: boolean): void {
  assert.ok(bodies.length >= 1, `${label}: read returned no messages`);
  for (const body of bodies) {
    assert.ok(body.length <= CAP, `${label}: retained ${body.length} chars`);
    if (big) {
      assert.ok(body.length > 0, `${label}: dropped the message body`);
      assert.ok(BIG_BODY.startsWith(body), `${label}: retained body is not the message prefix`);
    }
  }
  const total = bodies.reduce((sum, body) => sum + body.length, 0);
  assert.ok(total <= PAGE * CAP, `${label}: retained ${total} chars from the conversation`);
}

const failures: string[] = [];

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  resetMeter();
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  const problems = budgetProblems();
  if (problems.length > 0) {
    const extra = thrown instanceof Error ? ` after ${thrown.message}` : "";
    failures.push(`${name}: ${problems.join("; ")}${extra}`);
    return;
  }
  if (thrown) {
    failures.push(`${name}: threw ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
}

const { getGraphConversationMessages, getGraphMessage } = await import(
  "../src/lib/mail/graph.ts"
);
const { getGmailMessage, getGmailThreadMessages } = await import("../src/lib/mail/gmail.ts");
const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");

function outlook() {
  return new OutlookProvider({
    accessToken: "test-token",
    accountEmail: "owner@example.com",
    fetchImpl,
    pageSize: 40,
  });
}

function gmail() {
  return new GmailProvider({
    accessToken: "test-token",
    accountEmail: "owner@example.com",
    fetchImpl,
    pageSize: 40,
  });
}

await scenario("short outlook conversation keeps the full small body", async () => {
  const messages = await getGraphConversationMessages("test-token", "conv-short");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.htmlBody, SHORT_BODY);
  assert.equal(messages[1]?.htmlBody, SHORT_BODY);
});

await scenario("getGraphConversationMessages", async () => {
  const messages = await getGraphConversationMessages("test-token", "conv-1");
  assertKept(
    "getGraphConversationMessages",
    messages.map((message) => keptText(message)),
    true,
  );
});

await scenario("getGraphMessage", async () => {
  const message = await getGraphMessage("test-token", "m-0");
  assertKept("getGraphMessage", [keptText(message)], true);
});

await scenario("getGmailThreadMessages", async () => {
  const messages = await getGmailThreadMessages("test-token", "thread-1");
  assertKept(
    "getGmailThreadMessages",
    messages.map((message) => keptText(message)),
    true,
  );
});

await scenario("short gmail thread keeps the full small body", async () => {
  const opened = await getGmailMessage("test-token", "gs-0");
  assert.equal(opened.threadId, "thread-short");
  const messages = await getGmailThreadMessages("test-token", opened.threadId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.htmlBody, SHORT_BODY);
});

await scenario("OutlookProvider.getConversation", async () => {
  const conversation = await outlook().getConversation("conv-1");
  assertKept(
    "OutlookProvider.getConversation",
    conversation.messages.map((message) => keptText(message)),
    true,
  );
});

await scenario("OutlookProvider.syncFolder", async () => {
  const page = await outlook().syncFolder("inbox", null, { deadlineMs: Date.now() + 60_000 });
  const bodies = page.conversations.flatMap((conversation) =>
    conversation.messages.map((message) => keptText(message)),
  );
  assertKept("OutlookProvider.syncFolder", bodies, true);
});

await scenario("OutlookProvider.search", async () => {
  const result = await outlook().search("Budget");
  const bodies = result.conversations.flatMap((conversation) =>
    conversation.messages.map((message) => keptText(message)),
  );
  assertKept("OutlookProvider.search", bodies, true);
});

await scenario("OutlookProvider.reply", async () => {
  await outlook().reply({ conversationId: "conv-1", all: false, bodyHtml: "<p>ok</p>" }, "k");
});

await scenario("OutlookProvider.forward", async () => {
  await outlook().forward(
    { conversationId: "conv-1", to: [{ email: "other@example.com" }], bodyHtml: "<p>ok</p>" },
    "k",
  );
});

await scenario("OutlookProvider.moveConversation", async () => {
  await outlook().moveConversation("conv-1", "archive", "k");
});

await scenario("OutlookProvider.mutateConversation", async () => {
  await outlook().mutateConversation("conv-1", "markUnread", "k");
});

await scenario("GmailProvider.getConversation", async () => {
  const conversation = await gmail().getConversation("thread-1");
  assertKept(
    "GmailProvider.getConversation",
    conversation.messages.map((message) => keptText(message)),
    true,
  );
});

await scenario("GmailProvider.syncFolder", async () => {
  const page = await gmail().syncFolder("inbox", null, { deadlineMs: Date.now() + 60_000 });
  assertKept(
    "GmailProvider.syncFolder",
    page.conversations.flatMap((conversation) => conversation.messages.map((message) => keptText(message))),
    true,
  );
});

await scenario("GmailProvider.search", async () => {
  const result = await gmail().search("Budget");
  assertKept(
    "GmailProvider.search",
    result.conversations.flatMap((conversation) => conversation.messages.map((message) => keptText(message))),
    true,
  );
});

await scenario("GmailProvider.reply", async () => {
  await gmail().reply({ conversationId: "thread-1", all: true, bodyHtml: "<p>ok</p>" }, "k");
});

await scenario("GmailProvider.forward", async () => {
  await gmail().forward(
    { conversationId: "thread-1", to: [{ email: "other@example.com" }], bodyHtml: "<p>ok</p>" },
    "k",
  );
});

await scenario("GmailProvider.mutateConversation", async () => {
  await gmail().mutateConversation("thread-1", "archive", "k");
});

await scenario("GmailProvider.moveConversation does not download bodies", async () => {
  await gmail().moveConversation("thread-1", "Label_1", "k");
  assert.equal(meter.regions.length, 0);
});

const { GET: getLegacyMessage } = await import("../src/app/api/messages/[id]/route.ts");

async function legacyGet(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await getLegacyMessage(new Request(`http://localhost/api/messages/${id}`), {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

await scenario("GET /api/messages/{id} outlook", async () => {
  sessionState.provider = "microsoft-entra-id";
  const { status, body } = await legacyGet("m-0");
  assert.equal(status, 200, JSON.stringify(body).slice(0, 500));
  const message = body.message as { htmlBody?: string; textBody?: string };
  const thread = (body.thread as { htmlBody?: string; textBody?: string }[]) ?? [];
  assertKept("GET /api/messages outlook", [keptText(message), ...thread.map((turn) => keptText(turn))], true);
});

await scenario("GET /api/messages/{id} gmail", async () => {
  sessionState.provider = "google";
  const { status, body } = await legacyGet("g-0");
  assert.equal(status, 200, JSON.stringify(body).slice(0, 500));
  const message = body.message as { htmlBody?: string; textBody?: string };
  const thread = (body.thread as { htmlBody?: string; textBody?: string }[]) ?? [];
  assertKept("GET /api/messages gmail", [keptText(message), ...thread.map((turn) => keptText(turn))], true);
});

const pgLib = path.resolve("node_modules/@embedded-postgres/linux-x64/native/lib");
for (const name of ["libicuuc.so.60", "libicui18n.so.60", "libicudata.so.60"]) {
  const link = path.join(pgLib, name);
  if (!existsSync(link)) symlinkSync(`${name}.2`, link);
}
process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
  ? `${pgLib}:${process.env.LD_LIBRARY_PATH}`
  : pgLib;

const { startTestDb } = await import("./v2-testdb.mts");
const db = await startTestDb();
try {
  const original = db.pool.query.bind(db.pool);
  let maxCell = 0;
  db.pool.query = ((...args: Parameters<typeof db.pool.query>) => {
    const pending = original(...args);
    return Promise.resolve(pending).then((result) => {
      const rows = (result as { rows?: Record<string, unknown>[] }).rows ?? [];
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.length > maxCell) maxCell = value.length;
        }
      }
      return result;
    });
  }) as typeof db.pool.query;

  const { upsertUser, upsertAccount } = await import("../src/lib/v2/db/accounts.ts");
  const { asAccountId } = await import("../src/lib/v2/db/types.ts");
  const userId = await upsertUser("owner@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "owner@example.com",
  });
  accountState.current = {
    id: accountId,
    userId,
    provider: "microsoft",
    email: "owner@example.com",
    displayName: null,
    status: "active",
  };
  const inserted = await db.pool.query<{ id: string }>(
    `insert into seer.conversations (account_id, provider_conversation_id, subject, last_message_at, message_count)
     values ($1, 'conv-1', 'Budget thread', now(), $2)
     returning id`,
    [accountId, COUNT],
  );
  const conversationId = inserted.rows[0].id;
  for (let i = 0; i < COUNT; i++) {
    await db.pool.query(
      `insert into seer.messages (
         account_id, conversation_id, provider_message_id, from_email, from_name,
         to_emails, sent_at, snippet, body_html, is_unread, is_outgoing
       ) values ($1, $2, $3, 'attacker@example.com', 'Attacker', '{owner@example.com}', $4, $5, $6, true, false)`,
      [accountId, conversationId, `m-${i}`, outlookBig[i].when, BIG_BODY.slice(0, 255), BIG_BODY],
    );
  }
  maxCell = 0;

  const { getCorpusConversation } = await import("../src/lib/v3/reader/repository.ts");
  const { GET: getV3Conversation } = await import("../src/app/api/v3/conversations/[id]/route.ts");
  const { loadConversation, loadStoredConversations } = await import(
    "../src/lib/v2/intelligence/load-conversation.ts"
  );

  await scenario("getCorpusConversation", async () => {
    maxCell = 0;
    const view = await getCorpusConversation(asAccountId(accountId), conversationId, "microsoft");
    assert.ok(view);
    if (maxCell > CAP) {
      throw new Error(`database row delivered ${maxCell} chars > ${CAP}`);
    }
    assertKept(
      "getCorpusConversation",
      view.conversation.messages.map((message) => keptText(message)),
      true,
    );
  });

  await scenario("GET /api/v3/conversations/{id}", async () => {
    maxCell = 0;
    const response = await getV3Conversation(new Request("http://localhost/api/v3/conversations/" + conversationId), {
      params: Promise.resolve({ id: conversationId }),
    });
    const body = (await response.json()) as {
      conversation?: { messages?: { bodyHtml?: string | null; bodyText?: string | null }[] };
      error?: string;
    };
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
    if (maxCell > CAP) {
      throw new Error(`database row delivered ${maxCell} chars > ${CAP}`);
    }
    assertKept(
      "GET /api/v3/conversations",
      (body.conversation?.messages ?? []).map((message) => keptText(message)),
      true,
    );
  });

  await scenario("loadConversation", async () => {
    maxCell = 0;
    const conversation = await loadConversation(conversationId);
    assert.ok(conversation);
    if (maxCell > CAP) {
      throw new Error(`database row delivered ${maxCell} chars > ${CAP}`);
    }
    assertKept(
      "loadConversation",
      conversation.messages.map((message) => keptText(message)),
      true,
    );
  });

  await scenario("loadStoredConversations", async () => {
    maxCell = 0;
    const stored = await loadStoredConversations(asAccountId(accountId));
    assert.ok(stored.length >= 1);
    if (maxCell > CAP) {
      throw new Error(`database row delivered ${maxCell} chars > ${CAP}`);
    }
    assertKept(
      "loadStoredConversations",
      stored.flatMap((item) => item.conversation.messages.map((message) => keptText(message))),
      true,
    );
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("outlook-conversation-body-budget: OK");
