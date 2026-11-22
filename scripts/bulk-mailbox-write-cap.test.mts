/**
 * Spec for the uncapped mailbox-write bug.
 *
 * A signed-in mailbox can POST a list of message or thread ids and the
 * server writes to Gmail or Outlook once per row, in waves, with no
 * ceiling. These tests fail while that is true and pass once every
 * listed entry point refuses an over-cap list with HTTP 400 before any
 * provider call, and once one Outlook conversation cannot fan out into
 * more writes than the same cap.
 *
 * The cap matches the batch the delete and archive routes already slice
 * to. Over-cap means `length > MAX_BULK_ITEMS`. A list of exactly that
 * size is still carried out, so a fix cannot reject every request.
 *
 * Run (expected to fail until the handlers enforce the cap):
 *   node --experimental-test-module-mocks --import tsx scripts/bulk-mailbox-write-cap.test.mts
 *
 * Not covered here, and why:
 * - POST /api/delete and POST /api/archive slice the caller's ids to 25
 *   before any provider call, so one request cannot issue hundreds of writes.
 * - POST /api/matters close/unsettle archives thread ids stored on the
 *   matter or the closure, not a list taken from that request body.
 * - POST /api/triage/undo restores ids stored on a ledger entry. The
 *   request only names the entry.
 * - Delegate, send, and calendar routes act on a single message id.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "seer-bulk-cap-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
for (const name of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
]) {
  delete process.env[name];
}

/** Same ceiling as src/app/api/delete/route.ts and src/app/api/archive/route.ts. */
const MAX_BULK_ITEMS = 25;

const MAILBOX = "person@rditrials.com";
const TOKEN = "placeholder-access-token";

type Provider = "google" | "microsoft-entra-id";
type Action = "trash" | "archive" | "read";

type Session = {
  accessToken: string;
  provider: Provider;
  email: string;
  name: string;
  accountId: string;
};

let currentSession: Session | null = null;

function sessionFor(provider: Provider): Session {
  return {
    accessToken: TOKEN,
    provider,
    email: MAILBOX,
    name: "Person",
    accountId: "placeholder-account",
  };
}

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => currentSession,
  },
});

type Call = {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
};

const calls: Call[] = [];
/** How many messages a Graph conversation lookup returns, before $top. */
let conversationMessages = 1;

function installFetch() {
  calls.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      authorization: headers.get("authorization"),
      body: init?.body == null ? "" : String(init.body),
    });

    const parsed = new URL(url);
    if (parsed.pathname.includes("/mailFolders/inbox/messages")) {
      const top = Number(parsed.searchParams.get("$top") ?? String(conversationMessages));
      const value = Array.from({ length: conversationMessages }, (_, i) => ({
        id: `conv-msg-${i}`,
      })).slice(0, Number.isFinite(top) && top > 0 ? top : conversationMessages);
      return Response.json({ value });
    }
    if (parsed.pathname.endsWith("/mailFolders")) {
      return Response.json({ value: [{ id: "archive-folder" }] });
    }
    if (
      parsed.searchParams.get("format") === "metadata" ||
      parsed.searchParams.has("$select")
    ) {
      return Response.json({
        payload: { headers: [] },
        internetMessageHeaders: [],
      });
    }
    return new Response(null, { status: 200 });
  };
}

function writes(): Call[] {
  return calls.filter((call) => call.method !== "GET" && call.method !== "HEAD");
}

function items(count: number, action: Action, thread = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    ...(thread ? { threadId: `thread-${index}` } : {}),
    action,
  }));
}

async function post(
  handler: (request: Request) => Promise<Response>,
  url: string,
  body: unknown,
): Promise<Response> {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function assertNoProviderCalls(label: string) {
  assert.equal(
    calls.length,
    0,
    `${label} must not call the mailbox provider, but issued ${calls.length} call(s). First: ${calls[0]?.method ?? ""} ${calls[0]?.url ?? ""}`,
  );
}

function assertFanoutCapped(label: string) {
  const made = writes();
  assert.ok(
    made.length <= MAX_BULK_ITEMS,
    `${label} turned one conversation into ${made.length} mailbox writes (cap ${MAX_BULK_ITEMS}). First: ${made[0]?.method ?? ""} ${made[0]?.url ?? ""}`,
  );
}

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  currentSession = sessionFor("google");
  conversationMessages = 1;
  installFetch();
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

const bulkMod = await import("../src/app/api/action/bulk/route.ts");
const actionMod = await import("../src/app/api/action/route.ts");
const clearMod = await import("../src/app/api/triage/clear/route.ts");
const unsubMod = await import("../src/app/api/unsubscribe/route.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");

async function dataFiles(): Promise<string[]> {
  return (await readdir(dataDir).catch(() => [] as string[])).sort();
}

await check("bulk rejects an empty list before any provider call", async () => {
  const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
    items: [],
  });
  assert.equal(res.status, 400);
  assertNoProviderCalls("empty bulk");
});

await check("bulk refuses a signed-out caller before any provider call", async () => {
  currentSession = null;
  const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
    items: items(200, "trash"),
  });
  assert.equal(res.status, 401);
  assertNoProviderCalls("signed-out bulk");
});

for (const action of ["trash", "archive", "read"] as const) {
  await check(`bulk carries out exactly ${MAX_BULK_ITEMS} Gmail ${action} message writes`, async () => {
    const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
      items: items(MAX_BULK_ITEMS, action),
    });
    const json = (await res.json()) as { ok?: boolean; processed?: number };
    assert.equal(res.status, 200);
    assert.equal(json.processed, MAX_BULK_ITEMS);
    assert.equal(writes().length, MAX_BULK_ITEMS);
    assert.ok(
      writes().every(
        (call) =>
          call.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/") &&
          call.authorization === `Bearer ${TOKEN}`,
      ),
    );
    if (action === "trash") {
      assert.ok(writes().every((call) => call.url.endsWith("/trash") && call.method === "POST"));
    } else {
      const label = action === "archive" ? "INBOX" : "UNREAD";
      assert.ok(
        writes().every(
          (call) => call.url.endsWith("/modify") && call.body.includes(label),
        ),
      );
    }
  });

  await check(`bulk carries out exactly ${MAX_BULK_ITEMS} Outlook ${action} message writes`, async () => {
    currentSession = sessionFor("microsoft-entra-id");
    const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
      items: items(MAX_BULK_ITEMS, action),
    });
    const json = (await res.json()) as { processed?: number };
    assert.equal(res.status, 200);
    assert.equal(json.processed, MAX_BULK_ITEMS);
    assert.equal(writes().length, MAX_BULK_ITEMS);
    assert.ok(
      writes().every(
        (call) =>
          call.url.startsWith("https://graph.microsoft.com/v1.0/me/messages/") &&
          call.authorization === `Bearer ${TOKEN}`,
      ),
    );
    if (action === "trash") {
      assert.ok(writes().every((call) => call.method === "DELETE"));
    } else if (action === "read") {
      assert.ok(
        writes().every((call) => call.method === "PATCH" && call.body.includes("isRead")),
      );
    } else {
      assert.ok(writes().every((call) => call.url.endsWith("/move") && call.method === "POST"));
    }
  });
}

await check("bulk carries out one Gmail call for one thread id", async () => {
  const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
    items: [{ id: "msg-1", threadId: "thread-1", action: "trash" }],
  });
  assert.equal(res.status, 200);
  assert.equal(writes().length, 1);
  assert.equal(
    writes()[0]?.url,
    "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1/trash",
  );
});

await check("bulk carries out one Outlook write for a one-message conversation", async () => {
  currentSession = sessionFor("microsoft-entra-id");
  conversationMessages = 1;
  const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
    items: [{ id: "msg-1", threadId: "conversation-1", action: "trash" }],
  });
  assert.equal(res.status, 200);
  assert.equal(writes().length, 1);
  assert.ok(calls.some((call) => call.url.includes("conversation-1")));
  assert.ok(writes()[0]?.url.includes("/me/messages/conv-msg-0"));
  assert.equal(writes()[0]?.method, "DELETE");
});

for (const action of ["trash", "archive", "read"] as const) {
  for (const thread of [false, true]) {
    const shape = thread ? "thread" : "message";
    await check(
      `bulk rejects ${MAX_BULK_ITEMS + 1} Gmail ${action} ${shape} rows before any provider call`,
      async () => {
        const before = await dataFiles();
        const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
          items: items(MAX_BULK_ITEMS + 1, action, thread),
          reason: "sweep",
          source: "confirmed",
        });
        assertNoProviderCalls(`gmail ${action} ${shape} over cap`);
        assert.equal(res.status, 400);
        assert.deepEqual(await dataFiles(), before);
      },
    );

    await check(
      `bulk rejects ${MAX_BULK_ITEMS + 1} Outlook ${action} ${shape} rows before any provider call`,
      async () => {
        currentSession = sessionFor("microsoft-entra-id");
        const before = await dataFiles();
        const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
          items: items(MAX_BULK_ITEMS + 1, action, thread),
          reason: "sweep",
          source: "confirmed",
        });
        assertNoProviderCalls(`outlook ${action} ${shape} over cap`);
        assert.equal(res.status, 400);
        assert.deepEqual(await dataFiles(), before);
      },
    );
  }
}

await check("bulk rejects hundreds of Gmail trash rows before any provider call", async () => {
  const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
    items: items(200, "trash"),
  });
  assertNoProviderCalls("200 gmail trash rows");
  assert.equal(res.status, 400);
});

for (const action of ["trash", "archive", "read"] as const) {
  await check(
    `bulk caps Outlook ${action} fan-out from one conversation`,
    async () => {
      currentSession = sessionFor("microsoft-entra-id");
      conversationMessages = 40;
      const res = await post(bulkMod.POST, "http://localhost/api/action/bulk", {
        items: [{ id: "msg-1", threadId: "conversation-wide", action }],
      });
      assert.ok(calls.some((call) => call.url.includes("conversation-wide")));
      assertFanoutCapped(`bulk ${action} fan-out`);
      if (res.status === 200) {
        const json = (await res.json()) as { processed?: number };
        assert.ok((json.processed ?? 0) <= MAX_BULK_ITEMS);
      } else {
        assert.equal(res.status, 400);
        assert.equal(writes().length, 0);
      }
    },
  );

  await check(`single action caps Outlook ${action} fan-out from one conversation`, async () => {
    currentSession = sessionFor("microsoft-entra-id");
    conversationMessages = 40;
    const res = await post(actionMod.POST, "http://localhost/api/action", {
      id: "msg-1",
      threadId: "conversation-wide",
      action,
    });
    assert.ok(calls.some((call) => call.url.includes("conversation-wide")));
    assertFanoutCapped(`action ${action} fan-out`);
    if (res.status !== 200) {
      assert.equal(res.status, 400);
      assert.equal(writes().length, 0);
    }
  });
}

await check("single action still trashes one Gmail message", async () => {
  const res = await post(actionMod.POST, "http://localhost/api/action", {
    id: "msg-1",
    action: "trash",
  });
  assert.equal(res.status, 200);
  assert.equal(writes().length, 1);
  assert.equal(
    writes()[0]?.url,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1/trash",
  );
});

await kvSet(`brief:${MAILBOX}`, {
  builtAt: "2026-01-01T00:00:00.000Z",
  summary: "seed",
  matters: [],
  headlines: [],
  headlineIds: [],
  pinned: [],
});

function clearRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    threadId: `clear-thread-${index}`,
  }));
}

await check("triage clear carries out one Gmail thread trash", async () => {
  const res = await post(clearMod.POST, "http://localhost/api/triage/clear", {
    rows: clearRows(1),
    mode: "trash",
  });
  const json = (await res.json()) as { processed?: number; error?: string };
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.processed, 1);
  assert.equal(writes().length, 1);
  assert.ok(writes()[0]?.url.includes("/threads/clear-thread-0/trash"));
});

for (const mode of ["trash", "archive"] as const) {
  await check(
    `triage clear rejects ${MAX_BULK_ITEMS + 1} ${mode} rows before any provider call`,
    async () => {
      const before = await dataFiles();
      const res = await post(clearMod.POST, "http://localhost/api/triage/clear", {
        rows: clearRows(MAX_BULK_ITEMS + 1),
        mode,
      });
      assertNoProviderCalls(`triage ${mode} over cap`);
      assert.equal(res.status, 400);
      assert.deepEqual(await dataFiles(), before);
    },
  );

  await check(`triage clear caps Outlook ${mode} fan-out from one conversation`, async () => {
    currentSession = sessionFor("microsoft-entra-id");
    conversationMessages = 40;
    const res = await post(clearMod.POST, "http://localhost/api/triage/clear", {
      rows: [{ id: "row-1", threadId: "conversation-wide" }],
      mode,
    });
    assert.ok(calls.some((call) => call.url.includes("conversation-wide")));
    assertFanoutCapped(`triage ${mode} fan-out`);
    if (res.status !== 200) {
      assert.equal(writes().length, 0);
    }
  });
}

await check("unsubscribe carries out one Gmail trash", async () => {
  const res = await post(unsubMod.POST, "http://localhost/api/unsubscribe", {
    id: "msg-1",
  });
  assert.equal(res.status, 200);
  assert.ok(writes().some((call) => call.url.endsWith("/messages/msg-1/trash")));
});

await check("unsubscribe rejects a list above the cap before any provider call", async () => {
  const before = await dataFiles();
  const res = await post(unsubMod.POST, "http://localhost/api/unsubscribe", {
    items: items(200, "trash").map(({ id }) => ({ id })),
  });
  assertNoProviderCalls("unsubscribe list of 200");
  assert.equal(res.status, 400);
  assert.deepEqual(await dataFiles(), before);
});

await check("unsubscribe caps Outlook fan-out from one conversation", async () => {
  currentSession = sessionFor("microsoft-entra-id");
  conversationMessages = 40;
  const res = await post(unsubMod.POST, "http://localhost/api/unsubscribe", {
    id: "msg-1",
    threadId: "conversation-wide",
  });
  assert.ok(calls.some((call) => call.url.includes("conversation-wide")));
  assertFanoutCapped("unsubscribe fan-out");
  if (res.status !== 200) {
    assert.equal(writes().length, 0);
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
}
console.log("\nall bulk mailbox write cap tests passed");
