/**
 * Automated-matter collapse must key on the registrable domain, and
 * closing a matter must not archive a thread outside that domain.
 *
 * These tests fail while senderCompany uses the second-to-last label and
 * while close archives every stored thread id.
 *
 * Run from the repo root:
 *   ./node_modules/.bin/tsx --import ./scripts/public-suffix-matter-register.mjs ./scripts/public-suffix-matter-merge.test.mts
 *
 * The loader stubs the model SDK and the mail-session helper. Mailbox
 * HTTP is answered in this file at the fetch boundary; list, parse, brief
 * build, and the matters close route are the product code.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const aiMockPath = path.join(here, "public-suffix-ai-mock.cjs");
const sessionMockPath = path.join(here, "public-suffix-session-mock.cjs");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "ai") return aiMockPath;
  if (
    request === "@/lib/mail/session" ||
    request.endsWith("/lib/mail/session") ||
    request.endsWith("/lib/mail/session.ts") ||
    request.endsWith("/lib/mail/session.js")
  ) {
    return sessionMockPath;
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-psl-"));
for (const name of [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[name];
}

const { setGenerateText } = require("./public-suffix-ai-mock.cjs") as {
  setGenerateText: (next: (args?: { prompt?: string }) => Promise<unknown>) => void;
};
const { setMailSession } = require("./public-suffix-session-mock.cjs") as {
  setMailSession: (session: {
    accessToken: string;
    provider: string;
    email: string;
    name: string;
    accountId: string;
  } | null) => void;
};
const { buildBrief, saveBrief, loadBrief } = await import(
  "../src/lib/inbox/matters.ts"
);
const { listGmailFolder } = await import("../src/lib/mail/gmail.ts");
const { listGraphFolder } = await import("../src/lib/mail/graph.ts");
const { POST } = await import("../src/app/api/matters/route.ts");

const TOKEN = "placeholder-access-token";
const ORG = "operations — studies";

type Fixture = {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
};

type GmailCall = { url: string; method: string; body: string };
type GraphCall = { url: string; method: string; body: string };

const fixtures: Fixture[] = [];
let gmailCalls: GmailCall[] = [];
let graphCalls: GraphCall[] = [];
let gmailList: Fixture[] = [];
let graphList: Fixture[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty(status = 200): Response {
  return new Response("", { status });
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (
    init?.method ??
    (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
  ).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const decoded = decodeURIComponent(url.replace(/\+/g, " "));

  if (decoded.startsWith("https://gmail.googleapis.com/")) {
    gmailCalls.push({ url: decoded, method, body });
    if (decoded.includes("/users/me/threads/") && decoded.endsWith("/modify")) {
      return empty();
    }
    if (decoded.includes("/users/me/messages/") && decoded.includes("format=metadata")) {
      const id = decoded.match(/\/messages\/([^/?]+)/)?.[1] ?? "";
      const row = fixtures.find((f) => f.id === id);
      if (!row) return json({ error: "not found" }, 404);
      return json({
        id: row.id,
        threadId: row.threadId,
        snippet: row.snippet,
        internalDate: String(Date.parse(row.receivedAt)),
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "From", value: `${row.fromName} <${row.fromEmail}>` },
            { name: "Subject", value: row.subject },
            { name: "To", value: "Desk <desk@rditrials.com>" },
          ],
        },
      });
    }
    if (decoded.includes("/users/me/messages?")) {
      return json({
        messages: gmailList.map((row) => ({ id: row.id, threadId: row.threadId })),
      });
    }
    return json({ error: "unexpected gmail url" }, 404);
  }

  if (decoded.startsWith("https://graph.microsoft.com/")) {
    graphCalls.push({ url: decoded, method, body });
    if (decoded.includes("displayName eq 'Archive'")) {
      return json({ value: [{ id: "archive-folder" }] });
    }
    if (decoded.includes("/move")) {
      return empty();
    }
    const conversation = decoded.match(/conversationId eq '([^']+)'/)?.[1];
    if (conversation) {
      return json({
        value: fixtures
          .filter((row) => row.threadId === conversation)
          .map((row) => ({ id: row.id })),
      });
    }
    if (decoded.includes("/me/mailFolders/inbox/messages")) {
      return json({
        value: graphList.map((row) => ({
          id: row.id,
          conversationId: row.threadId,
          subject: row.subject,
          bodyPreview: row.snippet,
          receivedDateTime: row.receivedAt,
          isRead: false,
          from: {
            emailAddress: { name: row.fromName, address: row.fromEmail },
          },
        })),
      });
    }
    return json({ error: "unexpected graph url" }, 404);
  }

  return originalFetch(input, init);
};

function fixture(partial: Omit<Fixture, "subject" | "snippet" | "receivedAt"> & {
  subject?: string;
  snippet?: string;
  receivedAt?: string;
  n: number;
}): Fixture {
  const row: Fixture = {
    id: partial.id,
    threadId: partial.threadId,
    fromName: partial.fromName,
    fromEmail: partial.fromEmail,
    subject: partial.subject ?? "Approval still outstanding on the portal change",
    snippet:
      partial.snippet ??
      "Please approve the portal change. We are waiting on your decision.",
    receivedAt: partial.receivedAt ?? `2026-11-${String(partial.n).padStart(2, "0")}T15:00:00.000Z`,
  };
  fixtures.push(row);
  return row;
}

const rows = {
  evil: fixture({
    n: 1,
    id: "m-evil",
    threadId: "t-evil",
    fromName: "Alerts",
    fromEmail: "alerts@evil.co.uk",
  }),
  ceo: fixture({
    n: 2,
    id: "m-ceo",
    threadId: "t-ceo",
    fromName: "Notifications",
    fromEmail: "ceo@evil.co.uk",
  }),
  supplier: fixture({
    n: 3,
    id: "m-supplier",
    threadId: "t-supplier",
    fromName: "Supplier Notices",
    fromEmail: "noreply@supplier.co.uk",
  }),
  acmeA: fixture({
    n: 4,
    id: "m-acme-a",
    threadId: "t-acme-a",
    fromName: "Acme Notices",
    fromEmail: "noreply@mail.acme.co.uk",
  }),
  acmeB: fixture({
    n: 5,
    id: "m-acme-b",
    threadId: "t-acme-b",
    fromName: "Acme Alerts",
    fromEmail: "alerts@notify.acme.co.uk",
  }),
  auA: fixture({
    n: 6,
    id: "m-au-a",
    threadId: "t-au-a",
    fromName: "Billing Alerts",
    fromEmail: "alerts@billing.com.au",
  }),
  auB: fixture({
    n: 7,
    id: "m-au-b",
    threadId: "t-au-b",
    fromName: "Shipping",
    fromEmail: "noreply@shipping.com.au",
  }),
  brA: fixture({
    n: 8,
    id: "m-br-a",
    threadId: "t-br-a",
    fromName: "Fiscal Alerts",
    fromEmail: "alerts@fiscal.com.br",
  }),
  brB: fixture({
    n: 9,
    id: "m-br-b",
    threadId: "t-br-b",
    fromName: "Logistica",
    fromEmail: "noreply@logistica.com.br",
  }),
  blogA: fixture({
    n: 10,
    id: "m-blog-a",
    threadId: "t-blog-a",
    fromName: "Alpha Alerts",
    fromEmail: "alerts@alpha.blogspot.com",
  }),
  blogA2: fixture({
    n: 11,
    id: "m-blog-a2",
    threadId: "t-blog-a2",
    fromName: "Alpha Alerts",
    fromEmail: "alerts@news.alpha.blogspot.com",
  }),
  blogB: fixture({
    n: 12,
    id: "m-blog-b",
    threadId: "t-blog-b",
    fromName: "Beta",
    fromEmail: "noreply@beta.blogspot.com",
  }),
  ghA: fixture({
    n: 13,
    id: "m-gh-a",
    threadId: "t-gh-a",
    fromName: "Alice Alerts",
    fromEmail: "alerts@alice.github.io",
  }),
  ghB: fixture({
    n: 14,
    id: "m-gh-b",
    threadId: "t-gh-b",
    fromName: "Bob",
    fromEmail: "noreply@bob.github.io",
  }),
  jpA: fixture({
    n: 15,
    id: "m-jp-a",
    threadId: "t-jp-a",
    fromName: "One Alerts",
    fromEmail: "alerts@one.co.jp",
  }),
  jpB: fixture({
    n: 16,
    id: "m-jp-b",
    threadId: "t-jp-b",
    fromName: "Two",
    fromEmail: "noreply@two.co.jp",
  }),
  rocheA: fixture({
    n: 17,
    id: "m-roche-a",
    threadId: "t-roche-a",
    fromName: "Roche myBuy",
    fromEmail: "noreply@mybuy.roche.com",
  }),
  rocheB: fixture({
    n: 18,
    id: "m-roche-b",
    threadId: "t-roche-b",
    fromName: "Roche",
    fromEmail: "notifications@roche.com",
  }),
  abbott: fixture({
    n: 19,
    id: "m-abbott",
    threadId: "t-abbott",
    fromName: "Abbott Alerts",
    fromEmail: "alerts@abbott.com",
  }),
  thermo: fixture({
    n: 20,
    id: "m-thermo",
    threadId: "t-thermo",
    fromName: "Thermo",
    fromEmail: "noreply@thermofisher.com",
  }),
  jane: fixture({
    n: 21,
    id: "m-jane",
    threadId: "t-jane",
    fromName: "Alerts",
    fromEmail: "jane@vendor.com",
  }),
  vendA: fixture({
    n: 22,
    id: "m-vend-a",
    threadId: "t-vend-a",
    fromName: "Vendor Notices",
    fromEmail: "noreply@vendor.com",
  }),
  vendB: fixture({
    n: 23,
    id: "m-vend-b",
    threadId: "t-vend-b",
    fromName: "Vendor Alerts",
    fromEmail: "alerts@mail.vendor.com",
  }),
  foreign: fixture({
    n: 24,
    id: "m-foreign",
    threadId: "t-foreign",
    fromName: "Supplier Notices",
    fromEmail: "noreply@supplier.co.uk",
  }),
};

const inbox = Object.values(rows).filter((row) => row.id !== "m-foreign");

function understandingFor(row: Fixture) {
  return {
    id: row.id,
    threadId: row.threadId,
    version: 4,
    readAt: "2026-11-21T00:00:00.000Z",
    kind: "approval request",
    oneLine: "A portal change is waiting on your approval",
    ask: "Approve the portal change",
    owner: "you" as const,
    entities: [],
    org: { unit: ORG, confidence: 0.8 },
    importance: 2,
    disposition: "matter" as const,
    matterTitle: `Portal change ${row.id}`,
    matterWhy: "An approval is still outstanding",
  };
}

function understandingMap(rowsIn: Fixture[]) {
  return Object.fromEntries(rowsIn.map((row) => [row.id, understandingFor(row)]));
}

function mattersTouching(brief: { matters: { id: string; threadIds: string[] }[] }, threadId: string) {
  return brief.matters.filter((matter) => matter.threadIds.includes(threadId));
}

function assertExclusiveMatter(
  brief: { matters: { id: string; threadIds: string[] }[] },
  threadIds: string[],
  label: string,
) {
  const found = threadIds.map((threadId) => mattersTouching(brief, threadId));
  for (let i = 0; i < threadIds.length; i += 1) {
    assert.equal(
      found[i].length,
      1,
      `${label}: ${threadIds[i]} should be on exactly one matter, found ${found[i].length}`,
    );
  }
  const ids = new Set(found.map((list) => list[0].id));
  assert.equal(ids.size, 1, `${label}: ${threadIds.join(", ")} must be one matter`);
  const matter = found[0][0];
  const extras = matter.threadIds.filter((threadId) => !threadIds.includes(threadId));
  assert.deepEqual(
    extras,
    [],
    `${label}: matter ${matter.id} also holds ${extras.join(", ")}`,
  );
}

function assertSeparate(
  brief: { matters: { id: string; threadIds: string[] }[] },
  left: string,
  right: string,
  label: string,
) {
  const a = mattersTouching(brief, left);
  const b = mattersTouching(brief, right);
  assert.equal(a.length, 1, `${label}: ${left} missing`);
  assert.equal(b.length, 1, `${label}: ${right} missing`);
  assert.notEqual(a[0].id, b[0].id, label);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}

function leftoverModel() {
  setGenerateText(async () => ({
    output: { summary: "", matters: [], themes: [] },
  }));
}

async function loadProviderInbox(kind: "google" | "microsoft") {
  gmailCalls = [];
  graphCalls = [];
  if (kind === "google") {
    gmailList = inbox;
    const listed = await listGmailFolder(TOKEN, "inbox", 100);
    return listed.map((item) => ({
      ...item,
      guide: undefined,
    }));
  }
  graphList = inbox;
  const listed = await listGraphFolder(TOKEN, "inbox", 100);
  return listed.map((item) => ({
    ...item,
    guide: undefined,
  }));
}

const separateCases = [
  ["t-evil", "t-supplier", "evil.co.uk must not join supplier.co.uk"],
  ["t-evil", "t-ceo", "a display name must not make ceo@evil.co.uk a machine"],
  ["t-ceo", "t-supplier", "display-name sender must not join supplier.co.uk"],
  ["t-au-a", "t-au-b", "billing.com.au must not join shipping.com.au"],
  ["t-br-a", "t-br-b", "fiscal.com.br must not join logistica.com.br"],
  ["t-au-a", "t-br-a", "com.au must not join com.br"],
  ["t-blog-a", "t-blog-b", "alpha.blogspot.com must not join beta.blogspot.com"],
  ["t-gh-a", "t-gh-b", "alice.github.io must not join bob.github.io"],
  ["t-jp-a", "t-jp-b", "one.co.jp must not join two.co.jp"],
  ["t-jp-a", "t-evil", "co.jp must not join co.uk"],
  ["t-abbott", "t-thermo", "abbott.com must not join thermofisher.com"],
  ["t-jane", "t-vend-a", "display name Alerts must not fold jane@vendor.com into vendor.com machines"],
] as const;

function matterShell(
  id: string,
  threadIds: string[],
  emails: { id: string; threadId: string; fromEmail: string; from: string }[],
) {
  return {
    id,
    title: "Portal notices",
    category: "read",
    orgUnit: ORG,
    orgConfidence: 0.7,
    people: [],
    narrative: "Automated notices",
    nextAction: "Approve the portal change",
    owner: "you",
    urgency: 2,
    status: "active" as const,
    emails: emails.map((email) => ({
      id: email.id,
      threadId: email.threadId,
      from: email.from,
      fromEmail: email.fromEmail,
      line: "A portal change is waiting on your approval",
      suggestion: "Approve the portal change",
    })),
    emailIds: emails.map((email) => email.id),
    threadIds,
    updatedAt: "2026-11-21T16:00:00.000Z",
  };
}

async function closeMatter(account: string, provider: "google" | "microsoft-entra-id", matterId: string) {
  gmailCalls = [];
  graphCalls = [];
  setMailSession({
    accessToken: TOKEN,
    provider,
    email: account,
    name: "Desk",
    accountId: "acct-test",
  });
  const response = await POST(
    new Request("http://localhost/api/matters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close", matterId }),
    }),
  );
  const payload = (await response.json()) as { ok?: boolean; error?: string };
  return { status: response.status, payload };
}

function gmailArchivedThreads(): string[] {
  return gmailCalls
    .filter(
      (call) =>
        call.method === "POST" &&
        call.url.includes("/users/me/threads/") &&
        call.url.endsWith("/modify") &&
        call.body.includes("INBOX"),
    )
    .map((call) => call.url.match(/\/threads\/([^/]+)\/modify/)?.[1] ?? "")
    .filter(Boolean);
}

function graphArchivedMessages(): string[] {
  return graphCalls
    .filter((call) => call.method === "POST" && call.url.includes("/move"))
    .map((call) => call.url.match(/\/messages\/([^/]+)\/move/)?.[1] ?? "")
    .filter(Boolean);
}

console.log("public-suffix matter merge");

await check("gmail From header becomes the sender address", async () => {
  const items = await loadProviderInbox("google");
  const evil = items.find((item) => item.id === "m-evil");
  assert.equal(evil?.fromEmail, "alerts@evil.co.uk");
  assert.equal(evil?.fromName, "Alerts");
  const ceo = items.find((item) => item.id === "m-ceo");
  assert.equal(ceo?.fromEmail, "ceo@evil.co.uk");
  assert.equal(ceo?.fromName, "Notifications");
});

await check("graph from address becomes the sender address", async () => {
  const items = await loadProviderInbox("microsoft");
  const supplier = items.find((item) => item.id === "m-supplier");
  assert.equal(supplier?.fromEmail, "noreply@supplier.co.uk");
  assert.equal(supplier?.threadId, "t-supplier");
});

let gmailBrief: Awaited<ReturnType<typeof buildBrief>> | undefined;
let graphBrief: Awaited<ReturnType<typeof buildBrief>> | undefined;

await check("build the gmail brief from parsed From headers", async () => {
  leftoverModel();
  const items = await loadProviderInbox("google");
  gmailBrief = await buildBrief(
    "gmail-owner@rditrials.com",
    items,
    null,
    { messages: items.length, threads: items.length },
    understandingMap(inbox),
  );
  assert.ok(gmailBrief.matters.length > 0);
});

await check("build the outlook brief from parsed from addresses", async () => {
  leftoverModel();
  const items = await loadProviderInbox("microsoft");
  graphBrief = await buildBrief(
    "graph-owner@rditrials.com",
    items,
    null,
    { messages: items.length, threads: items.length },
    understandingMap(inbox),
  );
  assert.ok(graphBrief.matters.length > 0);
});

for (const [source, briefOf] of [
  ["gmail", () => gmailBrief],
  ["outlook", () => graphBrief],
] as const) {
  for (const [threads, name] of [
    [["t-acme-a", "t-acme-b"], "acme.co.uk subdomains stay one matter"],
    [["t-blog-a", "t-blog-a2"], "alpha.blogspot.com subdomains stay one matter"],
    [["t-roche-a", "t-roche-b"], "roche.com subdomains stay one matter"],
    [["t-vend-a", "t-vend-b"], "vendor.com machine addresses stay one matter"],
  ] as const) {
    await check(`${source}: ${name}`, () => {
      const brief = briefOf();
      assert.ok(brief, `${source} brief missing`);
      assertExclusiveMatter(brief, [...threads], `${source} ${name}`);
    });
  }
  for (const [left, right, name] of separateCases) {
    await check(`${source}: ${name}`, () => {
      const brief = briefOf();
      assert.ok(brief, `${source} brief missing`);
      assertSeparate(brief, left, right, name);
    });
  }
}

await check("a clusterer that already separated two suffixes is left alone", async () => {
  setGenerateText(async (args: { prompt?: string }) => {
    const prompt = String(args?.prompt ?? "");
    if (prompt.trim().startsWith("[")) {
      return { output: { summary: "", themes: [] } };
    }
    return {
      output: {
        summary: "",
        themes: [],
        matters: [
          {
            id: "evil-portal",
            title: "Evil portal approval",
            goal: "The evil portal change is decided",
            category: "ops",
            orgUnit: ORG,
            orgConfidence: 0.7,
            people: [],
            narrative: "Evil is waiting",
            nextAction: "Approve the portal change",
            owner: "you",
            urgency: 2,
            emailIds: ["m-evil"],
          },
          {
            id: "supplier-window",
            title: "Supplier shipping window",
            goal: "The supplier window is confirmed",
            category: "ops",
            orgUnit: ORG,
            orgConfidence: 0.7,
            people: [],
            narrative: "Supplier is waiting",
            nextAction: "Approve the portal change",
            owner: "you",
            urgency: 2,
            emailIds: ["m-supplier"],
          },
        ],
      },
    };
  });
  const items = (await loadProviderInbox("google")).filter((item) =>
    item.id === "m-evil" || item.id === "m-supplier",
  );
  const brief = await buildBrief(
    "clustered-owner@rditrials.com",
    items,
    null,
    { messages: items.length, threads: items.length },
    understandingMap([rows.evil, rows.supplier]),
  );
  assertSeparate(brief, "t-evil", "t-supplier", "clustered suffixes stay apart");
});

await check("closing a same-domain matter archives each of its threads", async () => {
  assert.ok(gmailBrief, "gmail brief missing");
  const roche = gmailBrief.matters.find(
    (matter) =>
      matter.threadIds.includes("t-roche-a") &&
      matter.threadIds.includes("t-roche-b") &&
      matter.threadIds.length === 2,
  );
  assert.ok(roche, "roche.com matter was not built as its own card");
  const result = await closeMatter("gmail-owner@rditrials.com", "google", roche.id);
  assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
  assert.deepEqual(gmailArchivedThreads().sort(), ["t-roche-a", "t-roche-b"]);
});

await check("closing a same-domain outlook matter moves each conversation", async () => {
  assert.ok(graphBrief, "graph brief missing");
  const roche = graphBrief.matters.find(
    (matter) =>
      matter.threadIds.includes("t-roche-a") &&
      matter.threadIds.includes("t-roche-b") &&
      matter.threadIds.length === 2,
  );
  assert.ok(roche, "roche.com matter was not built as its own card");
  const result = await closeMatter(
    "graph-owner@rditrials.com",
    "microsoft-entra-id",
    roche.id,
  );
  assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
  assert.deepEqual(graphArchivedMessages().sort(), ["m-roche-a", "m-roche-b"]);
});

await check("close does not archive threads that span registrable domains", async () => {
  const account = "close-mixed@rditrials.com";
  const matter = matterShell(
    "read:auto:co",
    ["t-evil", "t-supplier", "t-foreign"],
    [
      { id: "m-evil", threadId: "t-evil", from: "Alerts", fromEmail: "alerts@evil.co.uk" },
      {
        id: "m-supplier",
        threadId: "t-supplier",
        from: "Supplier Notices",
        fromEmail: "noreply@supplier.co.uk",
      },
    ],
  );
  await saveBrief(account, {
    builtAt: "2026-11-21T16:00:00.000Z",
    summary: "",
    matters: [matter],
    headlines: [],
    headlineIds: [],
    functions: [ORG],
    totalInbox: 3,
    filed: [],
  });
  const google = await closeMatter(account, "google", matter.id);
  const googleThreads = gmailArchivedThreads();
  assert.deepEqual(googleThreads, [], `google archived ${googleThreads.join(", ")} (status ${google.status})`);

  const stored = await loadBrief(account);
  assert.ok(stored, "mixed brief missing before outlook close");
  stored.matters = [matter];
  await saveBrief(account, stored);
  const outlook = await closeMatter(account, "microsoft-entra-id", matter.id);
  const moved = graphArchivedMessages();
  assert.deepEqual(moved, [], `graph moved ${moved.join(", ")} (status ${outlook.status})`);
});

await check("close does not archive a thread id with no from address on the card", async () => {
  const account = "close-extra@rditrials.com";
  const matter = matterShell(
    "read:auto:roche",
    ["t-roche-a", "t-roche-b", "t-foreign"],
    [
      {
        id: "m-roche-a",
        threadId: "t-roche-a",
        from: "Roche myBuy",
        fromEmail: "noreply@mybuy.roche.com",
      },
      {
        id: "m-roche-b",
        threadId: "t-roche-b",
        from: "Roche",
        fromEmail: "notifications@roche.com",
      },
    ],
  );
  await saveBrief(account, {
    builtAt: "2026-11-21T16:00:00.000Z",
    summary: "",
    matters: [matter],
    headlines: [],
    headlineIds: [],
    functions: [ORG],
    totalInbox: 3,
    filed: [],
  });
  await closeMatter(account, "google", matter.id);
  const archived = gmailArchivedThreads();
  assert.ok(!archived.includes("t-foreign"), `archived unlisted thread: ${archived.join(", ")}`);
  assert.deepEqual(archived.sort(), ["t-roche-a", "t-roche-b"]);
});

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
