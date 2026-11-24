/**
 * From, To, and Cc parsing must finish promptly on a long comma-free value.
 *
 * The cases below fail while that parse is a backtracking regular expression:
 * quadrupling the header multiplies the time by much more than four, and a
 * single long header blocks every caller. They pass once parsing is bounded.
 *
 *   npx tsx scripts/gmail-address-header-dos.test.mts
 *
 * Measured and not part of this suite, because they do not show this failure:
 * - src/lib/mail/gmail.ts parseAddress (legacy list/message). Its pattern does
 *   not go quadratic on a long run of less-than signs.
 * - src/lib/mail/graph.ts parseAddresses and src/app/api/send/route.ts
 *   reply-all extraction use /<([^>]+)>/, which does. Graph parses an address
 *   list the app is sending. Reply-all runs only after a signed-in session,
 *   which this suite does not construct.
 * - src/lib/mail/unsubscribe.ts scans List-Unsubscribe, a header Gmail caps
 *   at 32KB, off the sync worker.
 * - src/app/api/v2/bakeoff/route.ts parses caller-supplied preview samples.
 */
import assert from "node:assert/strict";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const SMALL = 16_000;
const LARGE = 64_000;
const BLOCKING = 80_000;
/** Headroom over a bounded parse, far under the unbounded cost of BLOCKING. */
const LIMIT_MS = 750;
/** Quadrupling a quadratic match is about 16x. Linear growth stays under this. */
const RATIO_LIMIT = 8;

const NORMAL_FROM = "Ada Lovelace <ada@example.com>";
const NORMAL_TO = "User <user@example.com>";
const NORMAL_CC = "Chris <chris@example.com>";

type HeaderMessage = {
  id: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
};

function lessThans(count: number): string {
  return "<".repeat(count);
}

/** Folding whitespace kept by RFC 5322 unfolding, with no comma and no '>'. */
function unfoldedLessThans(count: number): string {
  const parts: string[] = [];
  let left = count;
  while (left > 0) {
    const take = Math.min(75, left);
    parts.push("<".repeat(take));
    left -= take;
  }
  return parts.join(" ");
}

function message(id: string, headers: HeaderMessage) {
  return {
    id,
    threadId: id.split("-")[0],
    snippet: "snippet",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1700000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: headers.from ?? NORMAL_FROM },
        { name: "To", value: headers.to ?? NORMAL_TO },
        { name: "Cc", value: headers.cc ?? NORMAL_CC },
        { name: "Subject", value: headers.subject ?? "Hello" },
      ],
      body: { size: 2, data: Buffer.from("hi").toString("base64url") },
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function providerFor(
  threads: Record<string, ReturnType<typeof message>[]>,
): GmailProvider {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && target.includes("/threads?")) {
      return json({
        threads: Object.keys(threads).map((id) => ({ id })),
        resultSizeEstimate: Object.keys(threads).length,
      });
    }
    const got = target.match(/\/threads\/([^/?]+)/);
    if (method === "GET" && got) {
      const id = decodeURIComponent(got[1]);
      const messages = threads[id];
      if (!messages) throw new Error(`missing thread ${id}`);
      return json({ id, messages });
    }
    if (method === "POST" && target.endsWith("/messages/send")) {
      return json({ id: "sent-1", threadId: "sent-thread" });
    }
    throw new Error(`unexpected ${method} ${target}`);
  }) as typeof fetch;
  return new GmailProvider({
    accessToken: "test-access-token",
    accountEmail: "user@example.com",
    fetchImpl,
    pageSize: 10,
  });
}

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

async function bestOf(runs: number, run: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) best = Math.min(best, await elapsed(run));
  return best;
}

function assertFast(name: string, ms: number): void {
  assert.ok(
    ms < LIMIT_MS,
    `${name} took ${ms.toFixed(0)}ms parsing a ${BLOCKING}-character address header (limit ${LIMIT_MS}ms)`,
  );
}

async function testBenignAddresses(): Promise<void> {
  const provider = providerFor({
    t1: [
      message("t1-m1", {
        id: "t1-m1",
        from: '"Ada Lovelace" <Ada@Example.com>',
        to: "User <user@example.com>, Second <second@example.com>",
        cc: "chris@example.com",
      }),
    ],
  });
  const page = await provider.syncFolder("inbox");
  const parsed = page.conversations[0]?.messages[0];
  assert.ok(parsed);
  assert.equal(parsed.from.email, "ada@example.com");
  assert.equal(parsed.from.name, "Ada Lovelace");
  assert.deepEqual(
    parsed.to.map((address) => address.email),
    ["user@example.com", "second@example.com"],
  );
  assert.equal(parsed.to[0]?.name, "User");
  assert.deepEqual(
    parsed.cc.map((address) => address.email),
    ["chris@example.com"],
  );
}

async function testSyncCcDoesNotScaleQuadratically(): Promise<void> {
  const sync = (count: number) =>
    providerFor({
      t1: [message("t1-m1", { id: "t1-m1", cc: lessThans(count) })],
    }).syncFolder("inbox");
  await sync(1_000);
  const smallMs = await bestOf(2, () => sync(SMALL));
  const largeMs = await bestOf(2, () => sync(LARGE));
  assert.ok(
    largeMs < smallMs * RATIO_LIMIT,
    `Cc parsing scaled superlinearly: ${smallMs.toFixed(0)}ms at ${SMALL} chars vs ${largeMs.toFixed(0)}ms at ${LARGE} chars`,
  );
}

async function testSyncKeepsSiblingWhenCcIsUnfoldedLessThans(): Promise<void> {
  const provider = providerFor({
    t1: [
      message("t1-m1", { id: "t1-m1", subject: "Keep me" }),
      message("t1-m2", { id: "t1-m2", cc: unfoldedLessThans(BLOCKING) }),
    ],
  });
  const ms = await elapsed(() =>
    provider.syncFolder("inbox", null, { deadlineMs: Date.now() + 2_000 }).then((page) => {
      const messages = page.conversations[0]?.messages ?? [];
      assert.ok(
        messages.some((item) => item.from.email === "ada@example.com" && item.snippet === "snippet"),
        "healthy message in the same thread was dropped",
      );
    }),
  );
  assertFast("syncFolder unfolded Cc", ms);
}

async function testSyncToHeader(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", to: lessThans(BLOCKING) })],
  });
  assertFast("syncFolder To", await elapsed(() => provider.syncFolder("inbox")));
}

async function testSyncFromHeader(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", from: lessThans(BLOCKING) })],
  });
  assertFast("syncFolder From", await elapsed(() => provider.syncFolder("inbox")));
}

async function testGetConversation(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", cc: lessThans(BLOCKING) })],
  });
  assertFast(
    "getConversation",
    await elapsed(async () => {
      const conversation = await provider.getConversation("t1");
      assert.equal(conversation.messages.length, 1);
    }),
  );
}

async function testSearch(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", cc: lessThans(BLOCKING) })],
  });
  assertFast(
    "search",
    await elapsed(async () => {
      const result = await provider.search("invoice");
      assert.equal(result.conversations.length, 1);
    }),
  );
}

async function testReply(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", cc: lessThans(BLOCKING) })],
  });
  assertFast(
    "reply",
    await elapsed(() =>
      provider.reply({ conversationId: "t1", all: true, bodyHtml: "<p>ok</p>" }, "idem-key"),
    ),
  );
}

async function testForward(): Promise<void> {
  const provider = providerFor({
    t1: [message("t1-m1", { id: "t1-m1", cc: lessThans(BLOCKING) })],
  });
  assertFast(
    "forward",
    await elapsed(() =>
      provider.forward(
        {
          conversationId: "t1",
          to: [{ email: "other@example.com" }],
          bodyHtml: "<p>ok</p>",
        },
        "idem-key",
      ),
    ),
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ["benign address headers still parse", testBenignAddresses],
  ["sync Cc does not scale with the square of the header", testSyncCcDoesNotScaleQuadratically],
  ["sync keeps a sibling message when Cc is unfolded less-than signs", testSyncKeepsSiblingWhenCcIsUnfoldedLessThans],
  ["sync To header stays bounded", testSyncToHeader],
  ["sync From header stays bounded", testSyncFromHeader],
  ["getConversation stays bounded", testGetConversation],
  ["search stays bounded", testSearch],
  ["reply stays bounded", testReply],
  ["forward stays bounded", testForward],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} test(s) passed`);
