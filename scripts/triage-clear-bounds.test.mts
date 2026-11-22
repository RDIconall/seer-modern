/**
 * Bounds for POST /api/triage/clear and the undo path that replays its ids.
 *
 * These tests fail while a signed-in caller can:
 * - start one Gmail or Graph call per submitted row, all at once, or
 * - archive/trash a thread id that is not already in the stored brief, or
 * - fan out every message Graph returns for one conversation at once, or
 * - restore every thread id on a ledger entry at once.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/triage-clear-bounds.test.mts
 *
 * The fetch stand-in only supplies HTTP responses. Session lookup is the
 * signed-in mailbox the route already requires; planning, provider URL
 * construction, and the handler itself are the product code.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import type { Brief, FiledEmail, Matter } from "../src/lib/inbox/matters.ts";

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-triage-clear-"));
for (const name of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
]) {
  delete process.env[name];
}

/** Same wave size the bulk action route already uses. */
const MAX_IN_FLIGHT = 15;
/** Same per-request slice the single-message delete and archive routes use. */
const MAX_ROWS = 25;

const EMAIL = "triage-clear-test@rditrials.com";
const TOKEN = "test-access-token";

const session: {
  accessToken: string;
  provider: "google" | "microsoft-entra-id";
  email: string;
  name: string;
  accountId: string;
} = {
  accessToken: TOKEN,
  provider: "google",
  email: EMAIL,
  name: "Triage Clear Test",
  accountId: "acc-triage-clear-test",
};

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => session,
  },
});

const { POST: clear } = await import("../src/app/api/triage/clear/route.ts");
const { POST: undo } = await import("../src/app/api/triage/undo/route.ts");
const { saveBrief, loadBrief } = await import("../src/lib/inbox/matters.ts");
const { appendLedger } = await import("../src/lib/store/triage-ledger.ts");

type Call = { url: string; method: string; body: string; authorization: string };

function mentions(call: Call, id: string): boolean {
  const url = decodeURIComponent(call.url);
  return url.includes(id) || call.body.includes(id);
}

function installFetch(messagesByConversation: Record<string, string[]> = {}) {
  const calls: Call[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      body,
      authorization: headers.get("authorization") ?? "",
    });
    await Promise.resolve();
    try {
      const parsed = new URL(url);
      const filter = parsed.searchParams.get("$filter") ?? "";
      const listed = filter.match(/^conversationId eq '((?:[^']|'')*)'$/);
      if (parsed.pathname.endsWith("/me/mailFolders/inbox/messages") && listed) {
        const conversationId = listed[1].replace(/''/g, "'");
        const ids = messagesByConversation[conversationId] ?? [
          `listed-${conversationId}`,
        ];
        return Response.json({ value: ids.map((id) => ({ id })) });
      }
      if (parsed.pathname.endsWith("/me/mailFolders")) {
        return Response.json({ value: [{ id: "archive-folder" }] });
      }
      return new Response(null, { status: 200 });
    } finally {
      inflight -= 1;
    }
  }) as typeof fetch;
  return {
    calls,
    maxInflight: () => maxInflight,
    touched(ids: string[]) {
      return ids.filter((id) => calls.some((call) => mentions(call, id)));
    },
    restore() {
      globalThis.fetch = previous;
    },
  };
}

function filed(emailId: string, threadId: string): FiledEmail {
  return { emailId, threadId, orgUnit: "operations", line: "fyi" };
}

function matter(emailId: string, threadId: string): Matter {
  return {
    id: "matter-open",
    title: "Open matter",
    category: "ops",
    orgUnit: "operations",
    people: [],
    narrative: "Still open",
    nextAction: "Reply",
    owner: "you",
    urgency: 1,
    status: "active",
    emailIds: [emailId],
    threadIds: [threadId],
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function brief(overrides: Partial<Brief> = {}): Brief {
  return {
    builtAt: "2026-08-01T00:00:00.000Z",
    summary: "Stored brief",
    matters: [],
    headlines: [],
    headlineIds: [],
    totalInbox: 100,
    providerTotal: { messages: 100, threads: 80 },
    ...overrides,
  };
}

async function postClear(
  rows: { id: string; threadId: string }[],
  mode?: "archive" | "trash",
) {
  return clear(
    new Request("http://localhost/api/triage/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, mode, reason: "Triage" }),
    }),
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${error instanceof Error ? error.stack : error}`,
    );
  }
}

console.log("triage clear bounds");

await check("a filed thread is archived with the session token", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-filed", "thread-filed")] }),
  );
  const net = installFetch();
  try {
    const res = await postClear([
      { id: "msg-filed", threadId: "thread-filed" },
    ]);
    assert.equal(res.status, 200);
    const hit = net.calls.find((call) => call.url.includes("/threads/thread-filed/"));
    assert.ok(hit, "expected one Gmail thread call");
    assert.equal(hit.method, "POST");
    assert.equal(hit.url.endsWith("/threads/thread-filed/modify"), true);
    assert.match(hit.body, /INBOX/);
    assert.equal(hit.authorization, `Bearer ${TOKEN}`);
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
  }
});

await check("trash mode trashes the filed thread", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-trash", "thread-trash")] }),
  );
  const net = installFetch();
  try {
    const res = await postClear(
      [{ id: "msg-trash", threadId: "thread-trash" }],
      "trash",
    );
    assert.equal(res.status, 200);
    assert.equal(
      net.calls.some(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/threads/thread-trash/trash"),
      ),
      true,
    );
  } finally {
    net.restore();
  }
});

await check("a headline thread and a digest thread are cleared", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({
      headlines: [{ id: "msg-head", threadId: "thread-head", line: "headline" }],
      headlineIds: [{ id: "msg-head", threadId: "thread-head" }],
      digest: {
        summary: "noise",
        themes: [
          {
            theme: "Shipments",
            line: "packages",
            emailIds: ["msg-digest"],
            items: [
              {
                id: "msg-digest",
                threadId: "thread-digest",
                line: "shipped",
                at: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    }),
  );
  const net = installFetch();
  try {
    const res = await postClear([
      { id: "msg-head", threadId: "thread-head" },
      { id: "msg-digest", threadId: "thread-digest" },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(net.touched(["thread-head", "thread-digest"]).sort(), [
      "thread-digest",
      "thread-head",
    ]);
  } finally {
    net.restore();
  }
});

await check("an open matter message is modified, not the whole thread", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ matters: [matter("msg-matter", "thread-matter")] }),
  );
  const net = installFetch();
  try {
    const res = await postClear([
      { id: "msg-matter", threadId: "thread-matter" },
    ]);
    assert.equal(res.status, 200);
    assert.equal(
      net.calls.some((call) => call.url.includes("/threads/thread-matter/")),
      false,
    );
    assert.equal(
      net.calls.some(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/messages/msg-matter/modify"),
      ),
      true,
    );
  } finally {
    net.restore();
  }
});

await check("Gmail archive ignores a thread that is not in the brief", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-filed", "thread-filed")] }),
  );
  const net = installFetch();
  try {
    await postClear([
      { id: "msg-filed", threadId: "thread-filed" },
      { id: "msg-stranger", threadId: "thread-stranger" },
    ]);
    assert.deepEqual(net.touched(["thread-stranger", "msg-stranger"]), []);
  } finally {
    net.restore();
  }
});

await check("Gmail trash ignores a thread that is not in the brief", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-filed", "thread-filed")] }),
  );
  const net = installFetch();
  try {
    await postClear(
      [
        { id: "msg-filed", threadId: "thread-filed" },
        { id: "msg-stranger", threadId: "thread-stranger" },
      ],
      "trash",
    );
    assert.deepEqual(net.touched(["thread-stranger", "msg-stranger"]), []);
  } finally {
    net.restore();
  }
});

await check("Graph archive ignores a conversation that is not in the brief", async () => {
  session.provider = "microsoft-entra-id";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-filed", "thread-filed")] }),
  );
  const net = installFetch();
  try {
    await postClear([
      { id: "msg-filed", threadId: "thread-filed" },
      { id: "msg-stranger", threadId: "thread-stranger" },
    ]);
    assert.deepEqual(net.touched(["thread-stranger", "msg-stranger"]), []);
  } finally {
    net.restore();
  }
});

await check("Graph trash ignores a conversation that is not in the brief", async () => {
  session.provider = "microsoft-entra-id";
  await saveBrief(
    EMAIL,
    brief({ filed: [filed("msg-filed", "thread-filed")] }),
  );
  const net = installFetch();
  try {
    await postClear(
      [
        { id: "msg-filed", threadId: "thread-filed" },
        { id: "msg-stranger", threadId: "thread-stranger" },
      ],
      "trash",
    );
    assert.deepEqual(net.touched(["thread-stranger", "msg-stranger"]), []);
  } finally {
    net.restore();
  }
});

await check("a matter thread does not authorize arbitrary message ids", async () => {
  session.provider = "google";
  await saveBrief(
    EMAIL,
    brief({ matters: [matter("msg-matter", "thread-matter")] }),
  );
  const strangers = Array.from({ length: 40 }, (_, i) => `msg-stranger-${i}`);
  const net = installFetch();
  try {
    await postClear([
      { id: "msg-matter", threadId: "thread-matter" },
      ...strangers.map((id) => ({ id, threadId: "thread-matter" })),
    ]);
    assert.deepEqual(net.touched(strangers), []);
    assert.ok(net.maxInflight() <= MAX_IN_FLIGHT, `in flight ${net.maxInflight()}`);
  } finally {
    net.restore();
  }
});

await check("Graph matter messages stay inside the brief", async () => {
  session.provider = "microsoft-entra-id";
  await saveBrief(
    EMAIL,
    brief({ matters: [matter("msg-matter", "thread-matter")] }),
  );
  const strangers = Array.from({ length: 40 }, (_, i) => `msg-stranger-${i}`);
  const net = installFetch();
  try {
    await postClear([
      { id: "msg-matter", threadId: "thread-matter" },
      ...strangers.map((id) => ({ id, threadId: "thread-matter" })),
    ]);
    assert.deepEqual(net.touched(strangers), []);
    assert.equal(
      net.calls.some((call) => call.url.includes("thread-matter")),
      false,
    );
  } finally {
    net.restore();
  }
});

await check("Gmail clear bounds rows and in-flight calls", async () => {
  session.provider = "google";
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `msg-${String(i).padStart(4, "0")}`,
    threadId: `thread-${String(i).padStart(4, "0")}`,
  }));
  await saveBrief(EMAIL, brief({ filed: rows.map((row) => filed(row.id, row.threadId)) }));
  const net = installFetch();
  try {
    await postClear(rows);
    const touched = net.touched(rows.map((row) => row.threadId));
    const stored = await loadBrief(EMAIL);
    const left = stored?.filed?.length ?? 0;
    assert.ok(
      touched.length <= MAX_ROWS &&
        net.maxInflight() <= MAX_IN_FLIGHT &&
        left >= rows.length - MAX_ROWS,
      `named ${touched.length} threads, in flight ${net.maxInflight()}, brief kept ${left} filed rows`,
    );
  } finally {
    net.restore();
  }
});

await check("Graph clear bounds rows and in-flight calls", async () => {
  session.provider = "microsoft-entra-id";
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `msg-${String(i).padStart(4, "0")}`,
    threadId: `thread-${String(i).padStart(4, "0")}`,
  }));
  await saveBrief(EMAIL, brief({ filed: rows.map((row) => filed(row.id, row.threadId)) }));
  const messages: Record<string, string[]> = {};
  for (const row of rows) messages[row.threadId] = [row.id];
  const net = installFetch(messages);
  try {
    await postClear(rows, "trash");
    const touched = net.touched(rows.map((row) => row.threadId));
    assert.ok(
      touched.length <= MAX_ROWS && net.maxInflight() <= MAX_IN_FLIGHT,
      `named ${touched.length} conversations, in flight ${net.maxInflight()}`,
    );
  } finally {
    net.restore();
  }
});

await check("Graph thread clear does not call every message at once", async () => {
  session.provider = "microsoft-entra-id";
  const ids = Array.from({ length: 40 }, (_, i) => `gmsg-${String(i).padStart(2, "0")}`);
  await saveBrief(
    EMAIL,
    brief({ filed: [filed(ids[0], "thread-wide")] }),
  );
  const net = installFetch({ "thread-wide": ids });
  try {
    await postClear([{ id: ids[0], threadId: "thread-wide" }], "trash");
    const deleted = net.calls.filter((call) => call.method === "DELETE");
    assert.deepEqual(
      deleted.map((call) => call.url.split("/").pop()).sort(),
      [...ids].sort(),
    );
    assert.ok(
      net.maxInflight() <= MAX_IN_FLIGHT,
      `in flight ${net.maxInflight()}`,
    );
  } finally {
    net.restore();
  }
});

await check("undo does not restore every ledger thread at once", async () => {
  session.provider = "google";
  const threadIds = Array.from(
    { length: 60 },
    (_, i) => `undo-thread-${String(i).padStart(4, "0")}`,
  );
  const entry = await appendLedger(EMAIL, {
    kind: "sweep",
    summary: "Closed 60 — Triage",
    reason: "Triage",
    source: "confirmed",
    emailIds: threadIds.map((id) => `email-for-${id}`),
    threadIds,
  });
  const net = installFetch();
  try {
    const res = await undo(
      new Request("http://localhost/api/triage/undo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: entry.id }),
      }),
    );
    assert.equal(res.status, 200);
    assert.ok(net.touched(threadIds).length > 0, "expected the stored threads to be restored");
    assert.ok(
      net.maxInflight() <= MAX_IN_FLIGHT,
      `in flight ${net.maxInflight()}`,
    );
  } finally {
    net.restore();
  }
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
