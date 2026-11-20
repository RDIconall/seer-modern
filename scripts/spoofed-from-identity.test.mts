/**
 * Spoofed From is not the mailbox owner.
 *
 * Legacy grading and the Today, mailbox, and message views treat a
 * message as the owner's own mail when its From address equals the
 * signed-in mailbox. These tests drive the real route handlers. The
 * Gmail and Graph stand-in answers with the provider JSON those
 * clients already parse (users.messages payload.headers + labelIds,
 * Graph message.from). It returns Authentication-Results only when the
 * request asks for that header, which is what format=METADATA does.
 *
 * A message counts as the owner's only when its own labelIds include
 * SENT, or when THAT message's authentication result says the From
 * domain passed (dmarc=pass and header.from is the From domain). A
 * later Authentication-Results header does not overrule an earlier
 * failure. A SENT sibling in the same thread does not vouch for this
 * message. Every other inbox message is graded from its contents.
 *
 * The suggested clear is the same mapping the card stack uses
 * (primaryMailAction). Accepting it must not take this message out of
 * the inbox.
 *
 * Untested surfaces that share the grader, named so a fix does not
 * stop at the routes below:
 * - src/app/api/brief/route.ts rewrites From to "You" and then hands
 *   the rows to buildBrief inside after(); the HTTP body is only
 *   { ok, building }, so the name is not observable here.
 * - src/app/api/cron/sync/route.ts calls the same grader with the same
 *   fields, but it loads accounts from the database rather than
 *   requireMailSession.
 */

import assert from "node:assert/strict";
import Module from "node:module";

process.env.SEER_DATA_DIR = "/tmp/seer-spoof-identity-tests";
for (const name of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[name];
}

const OWNER = "owner@example.com";
const GRAPH_OWNER = "owner.graph@example.com";
const ATTACKER = "Pat Attacker";
const SUBJECT = "Payment failed on the invoice";
const SNIPPET = "The payment failed and the card was declined.";

const FAIL_THEN_FORGED = [
  "mx.google.com; dkim=fail header.i=@example.com; spf=fail smtp.mailfrom=owner@example.com; dmarc=fail header.from=example.com",
  "attacker.example; dmarc=pass header.from=example.com",
];
const PASS_ALIGNED = [
  "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=owner@example.com; dmarc=pass header.from=example.com",
];
const PASS_OTHER_DOMAIN = [
  "mx.google.com; dkim=pass header.i=@evil.test; spf=pass smtp.mailfrom=owner@evil.test; dmarc=pass header.from=evil.test",
];

type GmailFixture = {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  snippet: string;
  internalDate: string;
  auth: string[];
};

const gmailMessages: GmailFixture[] = [
  {
    id: "misaligned",
    threadId: "t-mis",
    labelIds: ["INBOX", "UNREAD"],
    from: `${ATTACKER} <${OWNER}>`,
    to: OWNER,
    subject: SUBJECT,
    snippet: SNIPPET,
    internalDate: String(Date.parse("2026-11-20T00:00:00.000Z")),
    auth: PASS_OTHER_DOMAIN,
  },
  {
    id: "auth-pass",
    threadId: "t-auth",
    labelIds: ["INBOX", "UNREAD"],
    from: `${ATTACKER} <${OWNER}>`,
    to: OWNER,
    subject: SUBJECT,
    snippet: SNIPPET,
    internalDate: String(Date.parse("2026-11-20T01:00:00.000Z")),
    auth: PASS_ALIGNED,
  },
  {
    id: "legit-sent",
    threadId: "t-sent",
    labelIds: ["INBOX", "SENT", "UNREAD"],
    from: `Owner <${OWNER}>`,
    to: "someone@example.com",
    subject: SUBJECT,
    snippet: SNIPPET,
    internalDate: String(Date.parse("2026-11-20T02:00:00.000Z")),
    auth: [],
  },
  {
    id: "sibling-sent",
    threadId: "t-spoof",
    labelIds: ["INBOX", "SENT", "UNREAD"],
    from: `Owner <${OWNER}>`,
    to: "someone@example.com",
    subject: SUBJECT,
    snippet: SNIPPET,
    internalDate: String(Date.parse("2026-11-19T12:00:00.000Z")),
    auth: [],
  },
  {
    id: "spoof-fail",
    threadId: "t-spoof",
    labelIds: ["INBOX", "UNREAD"],
    from: `${ATTACKER} <${OWNER}>`,
    to: OWNER,
    subject: SUBJECT,
    snippet: SNIPPET,
    internalDate: String(Date.parse("2026-11-20T03:00:00.000Z")),
    auth: FAIL_THEN_FORGED,
  },
];

const graphSpoof = {
  id: "g-spoof",
  conversationId: "g-thread",
  subject: SUBJECT,
  bodyPreview: SNIPPET,
  body: { contentType: "text", content: SNIPPET },
  receivedDateTime: "2026-11-20T03:00:00.000Z",
  isRead: false,
  from: {
    emailAddress: { name: ATTACKER, address: "Owner.Graph@example.com" },
  },
  toRecipients: [{ emailAddress: { address: GRAPH_OWNER } }],
  internetMessageId: "<g-spoof@example.com>",
};

type Call = { url: string; method: string; body?: string };
const calls: Call[] = [];
const unstubbed: string[] = [];

function b64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fixtureHeaders(message: GmailFixture, requested: string[] | null) {
  const all = [
    { name: "From", value: message.from },
    { name: "To", value: message.to },
    { name: "Subject", value: message.subject },
    { name: "Message-ID", value: `<${message.id}@example.com>` },
    ...message.auth.map((value) => ({
      name: "Authentication-Results",
      value,
    })),
  ];
  if (requested == null) return all;
  const want = new Set(requested.map((name) => name.toLowerCase()));
  return all.filter((header) => want.has(header.name.toLowerCase()));
}

function gmailResource(message: GmailFixture, requested: string[] | null) {
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    internalDate: message.internalDate,
    labelIds: message.labelIds,
    payload: {
      mimeType: "text/plain",
      headers: fixtureHeaders(message, requested),
      body: { data: b64url(message.snippet) },
    },
  };
}

function byId(id: string): GmailFixture | undefined {
  return gmailMessages.find((message) => message.id === id);
}

function threadOf(threadId: string): GmailFixture[] {
  return gmailMessages
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    const parsed = new URL(url);

    if (parsed.hostname === "gmail.googleapis.com") {
      const path = parsed.pathname.replace(/^\/gmail\/v1/, "");
      if (path === "/users/me/labels" && method === "GET") {
        return json(200, { labels: [] });
      }
      if (path === "/users/me/messages" && method === "GET") {
        const q = parsed.searchParams.get("q") ?? "";
        let ids: GmailFixture[] = [];
        if (q === "in:inbox" || q.startsWith("in:inbox ")) {
          ids = gmailMessages.filter((message) => message.labelIds.includes("INBOX"));
        } else if (q === "in:sent" || q.startsWith("in:sent ")) {
          ids = gmailMessages.filter((message) => message.labelIds.includes("SENT"));
        }
        return json(200, {
          messages: ids.map((message) => ({
            id: message.id,
            threadId: message.threadId,
          })),
        });
      }
      const messageGet = path.match(/^\/users\/me\/messages\/([^/]+)$/);
      if (messageGet && method === "GET") {
        const message = byId(decodeURIComponent(messageGet[1]));
        if (!message) return json(404, { error: "missing message" });
        const format = parsed.searchParams.get("format");
        const requested =
          format === "metadata" ? parsed.searchParams.getAll("metadataHeaders") : null;
        return json(200, gmailResource(message, requested));
      }
      const threadGet = path.match(/^\/users\/me\/threads\/([^/]+)$/);
      if (threadGet && method === "GET") {
        const messages = threadOf(decodeURIComponent(threadGet[1]));
        const format = parsed.searchParams.get("format");
        if (format === "minimal") {
          return json(200, { messages: messages.map((message) => ({ id: message.id })) });
        }
        const requested =
          format === "metadata" ? parsed.searchParams.getAll("metadataHeaders") : null;
        return json(200, {
          messages: messages.map((message) => gmailResource(message, requested)),
        });
      }
      if (method === "POST" && /\/modify$|\/trash$/.test(path)) {
        return json(200, {});
      }
    }

    if (parsed.hostname === "people.googleapis.com") {
      const field = parsed.pathname.includes("otherContacts") ? "otherContacts" : "connections";
      return json(200, { [field]: [] });
    }
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.includes("/calendar/")) {
      return json(200, { items: [] });
    }

    if (parsed.hostname === "graph.microsoft.com") {
      if (parsed.pathname === "/v1.0/me/mailFolders/inbox/messages") {
        return json(200, { value: [graphSpoof] });
      }
      if (parsed.pathname === "/v1.0/me/mailFolders/sentitems/messages") {
        return json(200, { value: [] });
      }
      if (parsed.pathname === "/v1.0/me/mailFolders" && method === "GET") {
        return json(200, { value: [{ id: "archive-folder" }] });
      }
      if (parsed.pathname === `/v1.0/me/messages/${graphSpoof.id}/move` && method === "POST") {
        return json(200, graphSpoof);
      }
      if (parsed.pathname === "/v1.0/me/contacts") {
        return json(200, { value: [] });
      }
      if (parsed.pathname === "/v1.0/me/calendarView") {
        return json(200, { value: [] });
      }
      if (parsed.pathname === "/v1.0/me/messages" && parsed.searchParams.get("$filter")?.includes("g-thread")) {
        return json(200, { value: [{ id: graphSpoof.id }] });
      }
      if (parsed.pathname === `/v1.0/me/messages/${graphSpoof.id}`) {
        if (method === "PATCH") return json(200, graphSpoof);
        if (method === "DELETE") return json(204, null);
        return json(200, graphSpoof);
      }
    }

    unstubbed.push(`${method} ${url}`);
    return json(404, { error: "unstubbed" });
  }) as typeof fetch;
}

type Session = {
  accessToken: string;
  provider: "google" | "microsoft-entra-id";
  email: string;
  name: string;
  accountId: string;
};

const session: Session = {
  accessToken: "test-access-token",
  provider: "google",
  email: OWNER,
  name: "Owner",
  accountId: "account-under-test",
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (this: NodeModule, id: string) {
  if (id === "@/lib/mail/session" || String(id).endsWith("/lib/mail/session.ts")) {
    return { requireMailSession: async () => session };
  }
  return originalRequire.apply(this, arguments);
} as typeof Module.prototype.require;

installFetch();

const { GET: getToday } = await import("../src/app/api/today/route.ts");
const { GET: getMailbox } = await import("../src/app/api/mailbox/route.ts");
const { GET: getMessage } = await import("../src/app/api/messages/[id]/route.ts");
const { GET: getAllTasks } = await import("../src/app/api/alltasks/route.ts");
const { GET: getCatchup } = await import("../src/app/api/catchup/route.ts");
const { POST: postAction } = await import("../src/app/api/action/route.ts");
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e instanceof Error ? e.message : e}`);
  }
}

function useGoogle() {
  session.provider = "google";
  session.email = OWNER;
  session.name = "Owner";
}

function useGraph() {
  session.provider = "microsoft-entra-id";
  session.email = GRAPH_OWNER;
  session.name = "Owner";
}

type Row = {
  id: string;
  threadId?: string;
  fromName: string;
  fromEmail: string;
  guide?: { action: string; debug?: { ruleId?: string }; reason?: string };
};

function findRow(rows: Row[], id: string): Row {
  const row = rows.find((item) => item.id === id);
  assert.ok(row, `missing row ${id}`);
  return row;
}

function assertUnverified(row: Row, where: string) {
  assert.equal(row.fromName, ATTACKER, `${where} ${row.id} display name`);
  assert.equal(row.guide?.action, "act_today", `${where} ${row.id} action`);
  assert.match(row.guide?.debug?.ruleId ?? "", /money-risk-act/, `${where} ${row.id} rule`);
  assert.doesNotMatch(row.guide?.debug?.ruleId ?? "", /self-sent/, `${where} ${row.id} rule`);
}

function assertOwn(row: Row, where: string) {
  assert.equal(row.fromName, "You", `${where} ${row.id} display name`);
  assert.equal(row.guide?.action, "read_and_archive", `${where} ${row.id} action`);
  assert.equal(row.guide?.debug?.ruleId, "self-sent", `${where} ${row.id} rule`);
  assert.equal(row.guide?.reason, "This is your own message — no reply yet");
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

console.log("spoofed From identity");

await kvSet(`last-open:${OWNER}`, "2000-01-01T00:00:00.000Z");
await kvSet(`last-open:${GRAPH_OWNER}`, "2000-01-01T00:00:00.000Z");

useGoogle();
const catchup = await readJson(await getCatchup());
const today = await readJson(await getToday());
const mailbox = await readJson(
  await getMailbox(new Request("http://localhost/api/mailbox?folder=inbox")),
);
const spoofMessage = await readJson(
  await getMessage(new Request("http://localhost/api/messages/spoof-fail"), {
    params: Promise.resolve({ id: "spoof-fail" }),
  }),
);
const sentMessage = await readJson(
  await getMessage(new Request("http://localhost/api/messages/legit-sent"), {
    params: Promise.resolve({ id: "legit-sent" }),
  }),
);
const authMessage = await readJson(
  await getMessage(new Request("http://localhost/api/messages/auth-pass"), {
    params: Promise.resolve({ id: "auth-pass" }),
  }),
);
const tasks = (await readJson(await getAllTasks())) as unknown as {
  taskType: string;
  email: { id: string };
}[];

const todayRows = today.inbox as Row[];
const mailboxRows = mailbox.items as Row[];

await check("Today keeps a spoofed inbox message, even when a SENT sibling shares the thread", async () => {
  assertUnverified(findRow(todayRows, "spoof-fail"), "today");
});

await check("Today still treats a SENT message as the owner's", async () => {
  assertOwn(findRow(todayRows, "legit-sent"), "today");
});

await check("Today treats a passing aligned authentication result as the owner's", async () => {
  assertOwn(findRow(todayRows, "auth-pass"), "today");
});

await check("Today ignores a passing result for a different domain", async () => {
  assertUnverified(findRow(todayRows, "misaligned"), "today");
});

await check("mailbox list keeps the spoof and the misaligned message", async () => {
  assertUnverified(findRow(mailboxRows, "spoof-fail"), "mailbox");
  assertUnverified(findRow(mailboxRows, "misaligned"), "mailbox");
});

await check("mailbox list still labels SENT and authenticated mail as You", async () => {
  assertOwn(findRow(mailboxRows, "legit-sent"), "mailbox");
  assertOwn(findRow(mailboxRows, "auth-pass"), "mailbox");
});

await check("message view grades the spoof and does not borrow the sibling SENT label", async () => {
  const message = spoofMessage.message as Row;
  assert.equal(message.fromName, ATTACKER);
  assert.equal((spoofMessage.guide as Row["guide"])?.action, "act_today");
  assert.match((spoofMessage.guide as Row["guide"])?.debug?.ruleId ?? "", /money-risk-act/);
  const turns = spoofMessage.thread as { id: string; fromName: string }[];
  const turnName = (id: string) => turns.find((turn) => turn.id === id)?.fromName;
  assert.equal(turnName("spoof-fail"), ATTACKER);
  assert.equal(turnName("sibling-sent"), "You");
});

await check("message view still labels a SENT message as You", async () => {
  assert.equal((sentMessage.message as Row).fromName, "You");
  assert.equal((sentMessage.guide as Row["guide"])?.debug?.ruleId, "self-sent");
});

await check("message view labels authenticated From as You and a mismatched domain as the sender", async () => {
  assert.equal((authMessage.message as Row).fromName, "You");
  assert.equal((authMessage.guide as Row["guide"])?.debug?.ruleId, "self-sent");
  const mis = await readJson(
    await getMessage(new Request("http://localhost/api/messages/misaligned"), {
      params: Promise.resolve({ id: "misaligned" }),
    }),
  );
  assert.equal((mis.message as Row).fromName, ATTACKER);
  assert.match((mis.guide as Row["guide"])?.debug?.ruleId ?? "", /money-risk-act/);
});

await check("all tasks grades the spoof as the payment failure, not as sent mail", async () => {
  const spoof = tasks.find((task) => task.email.id === "spoof-fail");
  const legit = tasks.find((task) => task.email.id === "legit-sent");
  assert.equal(spoof?.taskType, "act_today");
  assert.equal(legit?.taskType, "read_and_archive");
});

await check("catch-up counts the unverified messages as needing the reader", async () => {
  assert.equal(catchup.quiet, false);
  assert.equal(catchup.needsYou, 2);
  assert.equal(catchup.cleared, 3);
});

await check("accepting Today's suggestion for the spoof does not remove it from the inbox", async () => {
  const row = findRow(todayRows, "spoof-fail");
  assert.ok(row.guide);
  const action = primaryMailAction(row.guide.action as "act_today");
  const before = calls.length;
  const res = await postAction(
    new Request("http://localhost/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row.id,
        threadId: row.threadId,
        action,
        fromEmail: row.fromEmail,
      }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const acted = calls.slice(before);
  const removed = acted.filter((call) => {
    if (call.url.includes("/trash")) return true;
    if (!call.body) return false;
    const payload = JSON.parse(call.body) as { removeLabelIds?: string[] };
    return (payload.removeLabelIds ?? []).includes("INBOX");
  });
  assert.equal(removed.length, 0, JSON.stringify(acted.map((call) => ({ url: call.url, body: call.body }))));
  assert.equal(action, "read");
  assert.ok(
    acted.some(
      (call) =>
        call.url.includes("/users/me/threads/t-spoof/modify") &&
        call.body?.includes("UNREAD"),
    ),
    "the suggested read was not applied to the spoofed thread",
  );
});

useGraph();
const graphMailbox = await readJson(
  await getMailbox(new Request("http://localhost/api/mailbox?folder=inbox")),
);
const graphMessage = await readJson(
  await getMessage(new Request("http://localhost/api/messages/g-spoof"), {
    params: Promise.resolve({ id: "g-spoof" }),
  }),
);

await check("Outlook inbox mail with the mailbox in From is graded as the sender's request", async () => {
  const row = findRow(graphMailbox.items as Row[], "g-spoof");
  assertUnverified(row, "graph mailbox");
  assert.equal((graphMessage.message as { fromName: string }).fromName, ATTACKER);
  assert.equal((graphMessage.guide as Row["guide"])?.action, "act_today");
  const turns = graphMessage.thread as { fromName: string }[];
  assert.equal(turns[0]?.fromName, ATTACKER);
});

await check("accepting the Outlook suggestion does not archive the spoof", async () => {
  const row = findRow(graphMailbox.items as Row[], "g-spoof");
  assert.ok(row.guide);
  const action = primaryMailAction(row.guide.action as "act_today");
  const before = calls.length;
  const res = await postAction(
    new Request("http://localhost/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row.id,
        threadId: row.threadId,
        action,
        fromEmail: row.fromEmail,
      }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const acted = calls.slice(before);
  const archived = acted.filter(
    (call) =>
      call.method === "DELETE" ||
      call.url.includes("/move") ||
      call.url.includes("displayName eq 'Archive'"),
  );
  assert.equal(
    archived.length,
    0,
    JSON.stringify(acted.map((call) => ({ url: call.url, method: call.method, body: call.body }))),
  );
  assert.equal(action, "read");
  assert.ok(
    acted.some(
      (call) => call.method === "PATCH" && call.body?.includes('"isRead":true'),
    ),
    "the suggested read was not applied",
  );
});

if (unstubbed.length > 0) {
  console.error("unstubbed fetches:");
  for (const line of unstubbed) console.error(`  ${line}`);
}

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
