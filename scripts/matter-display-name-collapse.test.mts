/**
 * Spec for matter collapse on machine-word display names.
 *
 * These checks fail while a promoted human conversation is folded into the
 * company card because its display name is a machine word. They pass once a
 * sender is treated as automated only from the email address, so that human
 * conversation stays its own matter.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";
import type { Brief } from "../src/lib/inbox/matters.ts";

const dataDir = await mkdtemp(
  path.join(process.cwd(), ".tmp-matter-display-name-"),
);
process.env.SEER_DATA_DIR = dataDir;
for (const key of [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
]) {
  delete process.env[key];
}

const ACCESS_TOKEN = "placeholder-access-token";

type Provider = "google" | "microsoft-entra-id";

const session: {
  accessToken: string;
  provider: Provider;
  email: string;
  name: string;
  accountId: string;
} = {
  accessToken: ACCESS_TOKEN,
  provider: "google",
  email: "desk@rditrials.com",
  name: "Desk",
  accountId: "acct-placeholder",
};

// The route resolves the signed-in mailbox before it archives. This stand-in
// only supplies that session; the archive decision stays in the route.
mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => session,
  },
});

type Fixture = {
  id: string;
  threadId: string;
  name: string;
  address: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  ask: string;
  title: string;
};

let inbox: Fixture[] = [];
const calls: { url: string; method: string; body?: string }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const body = typeof init?.body === "string" ? init.body : undefined;
  calls.push({ url, method, body });

  if (url.startsWith("https://gmail.googleapis.com/")) {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/users/me/messages")) {
      return json({
        messages: inbox.map((m) => ({ id: m.id, threadId: m.threadId })),
      });
    }
    const one = parsed.pathname.match(/\/users\/me\/messages\/([^/]+)$/);
    if (one && method === "GET") {
      const message = inbox.find((m) => m.id === decodeURIComponent(one[1]));
      if (!message) return new Response("missing", { status: 404 });
      return json({
        id: message.id,
        threadId: message.threadId,
        snippet: message.snippet,
        internalDate: String(Date.parse(message.receivedAt)),
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          headers: [
            {
              name: "From",
              value: `"${message.name}" <${message.address}>`,
            },
            { name: "Subject", value: message.subject },
            { name: "To", value: "Desk <desk@rditrials.com>" },
            {
              name: "Authentication-Results",
              value: "mx.google.com; dmarc=fail header.from=roche.com",
            },
          ],
        },
      });
    }
    if (/\/threads\/[^/]+\/modify$/.test(parsed.pathname) && method === "POST") {
      return new Response("", { status: 200 });
    }
    return new Response("unexpected gmail url", { status: 500 });
  }

  if (url.startsWith("https://graph.microsoft.com/")) {
    if (url.includes("/mailFolders/inbox/messages")) {
      const parsed = new URL(url);
      const filter = parsed.searchParams.get("$filter") ?? "";
      const conversation = filter.match(/conversationId eq '([^']*)'/);
      const rows = conversation
        ? inbox.filter((m) => m.threadId === conversation[1])
        : inbox;
      if (parsed.searchParams.get("$select") === "id") {
        return json({ value: rows.map((m) => ({ id: m.id })) });
      }
      return json({
        value: rows.map((m) => ({
          id: m.id,
          conversationId: m.threadId,
          subject: m.subject,
          bodyPreview: m.snippet,
          receivedDateTime: m.receivedAt,
          isRead: false,
          from: {
            emailAddress: { name: m.name, address: m.address },
          },
          toRecipients: [
            { emailAddress: { address: "desk@rditrials.com" } },
          ],
        })),
      });
    }
    if (url.includes("/me/mailFolders?") && url.includes("Archive")) {
      return json({ value: [{ id: "archive-folder" }] });
    }
    if (url.includes("/move") && method === "POST") {
      return json({ id: "moved" });
    }
    return new Response("unexpected graph url", { status: 500 });
  }

  return json({ error: "model unavailable" }, 401);
}) as typeof fetch;

const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const { listGmailFolder } = await import("../src/lib/mail/gmail.ts");
const { listGraphFolder } = await import("../src/lib/mail/graph.ts");
const { loadClosedMatters } = await import("../src/lib/store/closed-matters.ts");
const mattersRoute = await import("../src/app/api/matters/route.ts");

const PO_ASK = "Review purchase order 4412";
const RECEIPT_ASK = "Approve receipt 88";
const WIRE_ASK = "Wire the vendor deposit today";

function fixture(
  id: string,
  name: string,
  address: string,
  receivedAt: string,
  ask: string,
  title: string,
): Fixture {
  return {
    id,
    threadId: `thr-${id}`,
    name,
    address,
    subject: title,
    snippet: ask,
    receivedAt,
    ask,
    title,
  };
}

function readFor(row: Fixture): Understanding {
  return {
    id: row.id,
    threadId: row.threadId,
    version: 4,
    readAt: "2026-08-09T00:00:00.000Z",
    kind: "request",
    oneLine: row.title,
    ask: row.ask,
    owner: "you",
    entities: ["Roche"],
    org: { unit: "operations — studies", confidence: 0.9 },
    importance: 2,
    disposition: "matter",
    matterTitle: row.title,
    matterWhy: row.ask,
  };
}

function rocheNotices(tag: string): { po: Fixture; receipt: Fixture } {
  return {
    po: fixture(
      `${tag}-po`,
      "Roche myBuy",
      "notifications@mybuy.roche.com",
      "2026-08-01T12:00:00.000Z",
      PO_ASK,
      "Roche purchase order 4412",
    ),
    receipt: fixture(
      `${tag}-receipt`,
      "Ariba",
      "ariba@procure.roche.com",
      "2026-08-02T12:00:00.000Z",
      RECEIPT_ASK,
      "Roche receipt 88",
    ),
  };
}

async function loadInbox(
  provider: Provider,
  rows: Fixture[],
): Promise<EmailItem[]> {
  inbox = rows;
  if (provider === "google") {
    return listGmailFolder(ACCESS_TOKEN, "inbox", 20);
  }
  return listGraphFolder(ACCESS_TOKEN, "inbox", 20);
}

async function briefFor(
  account: string,
  provider: Provider,
  rows: Fixture[],
): Promise<{ brief: Brief; items: EmailItem[] }> {
  const items = await loadInbox(provider, rows);
  for (const row of rows) {
    const parsed = items.find((item) => item.id === row.id);
    assert.ok(parsed, `provider dropped ${row.id}`);
    assert.equal(parsed.fromName, row.name);
    assert.equal(parsed.fromEmail, row.address);
    assert.equal(parsed.threadId, row.threadId);
  }
  const understanding: Record<string, Understanding> = {};
  for (const row of rows) understanding[row.id] = readFor(row);
  const brief = await buildBrief(
    account,
    items,
    null,
    { messages: items.length, threads: items.length },
    understanding,
  );
  assert.equal(
    brief.clusterFailures,
    1,
    "clustering must fail closed so these rows take the promotion path",
  );
  return { brief, items };
}

function matterOwning(brief: Brief, threadId: string) {
  const hits = brief.matters.filter((matter) =>
    matter.threadIds.includes(threadId),
  );
  assert.equal(
    hits.length,
    1,
    `thread ${threadId} belongs to ${hits.length} matters (${brief.matters
      .map((matter) => `${matter.id}[${matter.threadIds.join(",")}]`)
      .join(" ")})`,
  );
  return hits[0];
}

function assertHumanStandsAlone(
  brief: Brief,
  human: Fixture,
  automated: Fixture[],
) {
  const humanMatter = matterOwning(brief, human.threadId);
  const automatedMatter = matterOwning(brief, automated[0].threadId);
  assert.deepEqual(
    {
      sameCard: humanMatter.id === automatedMatter.id,
      humanThreads: [...humanMatter.threadIds].sort(),
      humanAction: humanMatter.nextAction,
      automatedThreads: [...automatedMatter.threadIds].sort(),
      automatedAction: automatedMatter.nextAction,
    },
    {
      sameCard: false,
      humanThreads: [human.threadId],
      humanAction: human.ask,
      automatedThreads: automated.map((row) => row.threadId).sort(),
      automatedAction: RECEIPT_ASK,
    },
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
    );
  }
}

console.log("matter display-name collapse");

const machineNames = ["Jira", "notifications", "ServiceNow", "noreply"] as const;

for (const machineName of machineNames) {
  await check(
    `Gmail: a promoted ${machineName} display name on a human address stays its own Roche matter`,
    async () => {
      const tag = machineName.toLowerCase().replace(/[^a-z]/g, "");
      const notices = rocheNotices(tag);
      const human = fixture(
        `${tag}-human`,
        machineName,
        "procurement.lead@roche.com",
        "2026-08-03T12:00:00.000Z",
        WIRE_ASK,
        "Roche vendor deposit",
      );
      const { brief } = await briefFor(
        `desk-${tag}@rditrials.com`,
        "google",
        [notices.po, notices.receipt, human],
      );
      assertHumanStandsAlone(brief, human, [notices.po, notices.receipt]);
    },
  );
}

await check(
  "Gmail: an older human request is not buried under a newer automated Roche notice",
  async () => {
    const notices = rocheNotices("older");
    const human = fixture(
      "older-human",
      "Jira",
      "procurement.lead@roche.com",
      "2026-07-15T12:00:00.000Z",
      WIRE_ASK,
      "Roche vendor deposit",
    );
    const { brief } = await briefFor(
      "desk-older@rditrials.com",
      "google",
      [human, notices.po, notices.receipt],
    );
    assertHumanStandsAlone(brief, human, [notices.po, notices.receipt]);
  },
);

await check(
  "Outlook: a promoted notifications display name on a human address stays its own Roche matter",
  async () => {
    const notices = rocheNotices("graph");
    const human = fixture(
      "graph-human",
      "notifications",
      "procurement.lead@roche.com",
      "2026-08-03T12:00:00.000Z",
      WIRE_ASK,
      "Roche vendor deposit",
    );
    const { brief } = await briefFor(
      "desk-graph@rditrials.com",
      "microsoft-entra-id",
      [notices.po, notices.receipt, human],
    );
    assertHumanStandsAlone(brief, human, [notices.po, notices.receipt]);
  },
);

await check(
  "a real person's display name is not folded into the Roche automated card",
  async () => {
    const notices = rocheNotices("person");
    const human = fixture(
      "person-human",
      "Ajda Guttormsen",
      "ajda.guttormsen@roche.com",
      "2026-08-03T12:00:00.000Z",
      "Send the anti-TPO pricing",
      "Roche anti-TPO pricing",
    );
    const { brief } = await briefFor(
      "desk-person@rditrials.com",
      "google",
      [notices.po, notices.receipt, human],
    );
    const humanMatter = matterOwning(brief, human.threadId);
    assert.deepEqual(humanMatter.threadIds, [human.threadId]);
    assert.equal(humanMatter.nextAction, human.ask);
    const automatedMatter = matterOwning(brief, notices.po.threadId);
    assert.notEqual(automatedMatter.id, humanMatter.id);
    assert.equal(automatedMatter.nextAction, RECEIPT_ASK);
    assert.deepEqual(
      [...automatedMatter.threadIds].sort(),
      [notices.po.threadId, notices.receipt.threadId].sort(),
    );
  },
);

function archivedGmailThreads(): string[] {
  return calls.flatMap((call) => {
    const match = call.url.match(/\/threads\/([^/]+)\/modify$/);
    if (!match || call.method !== "POST") return [];
    const body = JSON.parse(call.body ?? "{}") as { removeLabelIds?: string[] };
    assert.deepEqual(body.removeLabelIds, ["INBOX"]);
    return [decodeURIComponent(match[1])];
  });
}

function archivedGraphThreads(): string[] {
  const moved = calls.flatMap((call) => {
    const match = call.url.match(/\/messages\/([^/]+)\/move$/);
    if (!match || call.method !== "POST") return [];
    const body = JSON.parse(call.body ?? "{}") as { destinationId?: string };
    assert.equal(body.destinationId, "archive-folder");
    return [decodeURIComponent(match[1])];
  });
  return [
    ...new Set(
      moved.map((id) => inbox.find((row) => row.id === id)?.threadId ?? id),
    ),
  ];
}

async function closeMatter(matterId: string) {
  calls.length = 0;
  const response = await mattersRoute.POST(
    new Request("http://localhost/api/matters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close", matterId }),
    }),
  );
  const payload = (await response.json()) as {
    ok?: boolean;
    error?: string;
    brief?: Brief;
  };
  assert.equal(
    response.status,
    200,
    payload.error ?? `close returned ${response.status}`,
  );
  return payload;
}

await check(
  "closing the Roche automated card does not archive the human conversation",
  async () => {
    const notices = rocheNotices("close");
    const human = fixture(
      "close-human",
      "Jira",
      "procurement.lead@roche.com",
      "2026-08-03T12:00:00.000Z",
      WIRE_ASK,
      "Roche vendor deposit",
    );
    const account = "desk-close@rditrials.com";
    session.email = account;
    session.provider = "google";
    const { brief } = await briefFor(account, "google", [
      notices.po,
      notices.receipt,
      human,
    ]);
    const automated = matterOwning(brief, notices.po.threadId);
    const closed = await closeMatter(automated.id);
    assert.deepEqual(
      archivedGmailThreads().sort(),
      [notices.po.threadId, notices.receipt.threadId].sort(),
    );
    const closure = (await loadClosedMatters(account))[automated.id];
    assert.ok(closure);
    assert.deepEqual(
      [...closure.threadIds].sort(),
      [notices.po.threadId, notices.receipt.threadId].sort(),
    );
    const surviving = closed.brief?.matters.filter((matter) =>
      matter.threadIds.includes(human.threadId),
    );
    assert.equal(surviving?.length, 1);
    assert.deepEqual(surviving?.[0].threadIds, [human.threadId]);
    assert.equal(surviving?.[0].nextAction, WIRE_ASK);
  },
);

await check(
  "closing the Roche automated card on Outlook does not archive the human conversation",
  async () => {
    const notices = rocheNotices("graphclose");
    const human = fixture(
      "graphclose-human",
      "ServiceNow",
      "procurement.lead@roche.com",
      "2026-08-03T12:00:00.000Z",
      WIRE_ASK,
      "Roche vendor deposit",
    );
    const account = "desk-graphclose@rditrials.com";
    session.email = account;
    session.provider = "microsoft-entra-id";
    const { brief } = await briefFor(account, "microsoft-entra-id", [
      notices.po,
      notices.receipt,
      human,
    ]);
    const automated = matterOwning(brief, notices.po.threadId);
    await closeMatter(automated.id);
    assert.deepEqual(
      archivedGraphThreads().sort(),
      [notices.po.threadId, notices.receipt.threadId].sort(),
    );
    const closure = (await loadClosedMatters(account))[automated.id];
    assert.ok(closure);
    assert.equal(closure.threadIds.includes(human.threadId), false);
  },
);

try {
  await rm(dataDir, { recursive: true, force: true });
} catch {
  /* the temp mailbox is local to this run */
}
if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
