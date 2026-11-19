/**
 * A closed matter must stay closed when a different conversation's title
 * merely overlaps it. These tests exercise the brief rebuild the product
 * runs: a deep read copies the model's matterTitle (the prompt tells the
 * model to name that title from the message) into the understanding store,
 * then buildBrief promotes or clusters that thread and decides whether the
 * closure record survives.
 *
 * They fail while a two-word overlap, or any newer mail on a thread that
 * was not part of the closure, deletes that record.
 *
 * Run: tsx scripts/closed-matter-overlap.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const aiDoubleUrl = new URL("./ai-test-double.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "ai") {
      return { url: aiDoubleUrl, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes("/node_modules/ai/")) {
      return { url: aiDoubleUrl, shortCircuit: true };
    }
    return resolved;
  },
});
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";
import type { Brief } from "../src/lib/inbox/matters.ts";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-closure-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
for (const name of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[name];
}

/** What the clustering pass returns. Empty means the read is promoted. */
function setClusteredMatters(matters: Record<string, unknown>[]) {
  const state = (globalThis.__seerClosureAi ??= { calls: [] });
  state.clusteredMatters = matters;
}

const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const {
  closeMatter,
  loadClosedMatters,
  matchesClosure,
  titleTokensOf,
} = await import("../src/lib/store/closed-matters.ts");
const { readEmails } = await import("../src/lib/inbox/understanding.ts");
const { mergeUnderstanding } = await import(
  "../src/lib/store/understanding-store.ts"
);

const CLOSED_AT = "2026-01-15T00:00:00.000Z";
const BEFORE = "2025-12-01T00:00:00.000Z";
const AFTER = "2026-02-01T00:00:00.000Z";
const CLOSED_TITLE = "Roche anti-TPO pricing contract";
const CLOSED_ID = "matter-roche-pricing-contract";

let failures = 0;

function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e: unknown) => {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
      );
    });
}

function mail(input: {
  id: string;
  threadId: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  snippet?: string;
}): EmailItem {
  return {
    id: input.id,
    threadId: input.threadId,
    fromEmail: input.fromEmail,
    fromName: "Outside Sender",
    subject: input.subject,
    snippet: input.snippet ?? input.subject,
    receivedAt: input.receivedAt,
    isUnread: true,
  };
}

function understanding(
  item: EmailItem,
  disposition: Understanding["disposition"],
  matterTitle?: string,
): Understanding {
  return {
    id: item.id,
    threadId: item.threadId,
    version: 4,
    readAt: item.receivedAt,
    kind: "pricing request",
    oneLine: item.snippet,
    ask:
      disposition === "matter" ? "Send the requested paperwork" : "nothing — informational",
    owner: disposition === "matter" ? "you" : "nobody",
    entities: ["Roche"],
    org: { unit: "sales — contracting", confidence: 0.9 },
    importance: 2,
    disposition,
    ...(matterTitle ? { matterTitle, matterWhy: item.snippet } : {}),
  };
}

async function close(
  account: string,
  threadIds: string[],
  title = CLOSED_TITLE,
  matterId = CLOSED_ID,
) {
  await closeMatter(account, {
    matterId,
    titleTokens: titleTokensOf(title),
    threadIds,
    reason: "You closed it",
    by: "user",
    closedAt: CLOSED_AT,
    matter: {
      id: matterId,
      title,
      category: "read",
      orgUnit: "sales — contracting",
      people: [],
      narrative: "Closed pricing work",
      nextAction: "none",
      owner: "you",
      urgency: 1,
      emailIds: threadIds.map((t) => `${t}-msg`),
      threadIds,
      updatedAt: CLOSED_AT,
    },
  });
}

function activeThreadIds(brief: Brief): Set<string> {
  const ids = new Set<string>();
  for (const m of [...brief.matters, ...(brief.pinned ?? [])]) {
    for (const t of m.threadIds ?? []) ids.add(t);
  }
  return ids;
}

function reopenedThreads(brief: Brief): string[] {
  return brief.matters
    .filter((m) => m.status === "reopened")
    .flatMap((m) => m.threadIds);
}

async function rebuild(
  account: string,
  items: EmailItem[],
  map: Record<string, Understanding>,
  matters: Record<string, unknown>[] = [],
): Promise<Brief> {
  setClusteredMatters(matters);
  return buildBrief(account, items, null, null, map, new Set());
}

function clusterMatter(
  item: EmailItem,
  title: string,
): Record<string, unknown> {
  return {
    id: `cluster-${item.threadId}`,
    title,
    goal: "The ask is answered",
    category: "new-business",
    orgUnit: "sales — contracting",
    orgConfidence: 0.8,
    people: [],
    narrative: "A sender is waiting",
    nextAction: "Reply",
    owner: "you",
    urgency: 2,
    emailIds: [item.id],
  };
}

console.log("closed matter overlap");

await check(
  "a two-word subset is not the same closed matter",
  () => {
    const closure = {
      matterId: CLOSED_ID,
      titleTokens: titleTokensOf(CLOSED_TITLE),
      threadIds: ["thread-original-a", "thread-original-b"],
      closedAt: CLOSED_AT,
      reason: "You closed it",
      by: "user" as const,
    };
    assert.equal(
      matchesClosure(
        {
          id: "read:thread-attacker",
          title: "pricing contract",
          threadIds: ["thread-attacker"],
        },
        closure,
      ),
      false,
    );
    assert.equal(
      matchesClosure(
        {
          id: "read:thread-attacker",
          title: "Pricing contracts",
          threadIds: ["thread-attacker"],
        },
        closure,
      ),
      false,
    );
    assert.equal(
      matchesClosure(
        {
          id: "read:thread-long",
          title: CLOSED_TITLE,
          threadIds: ["thread-long"],
        },
        {
          ...closure,
          titleTokens: titleTokensOf("pricing contract"),
        },
      ),
      false,
    );
  },
);

await check(
  "the same thread, or an identical normalized title, still matches",
  () => {
    const closure = {
      matterId: CLOSED_ID,
      titleTokens: titleTokensOf(CLOSED_TITLE),
      threadIds: ["thread-original-a"],
      closedAt: CLOSED_AT,
      reason: "You closed it",
      by: "user" as const,
    };
    assert.equal(
      matchesClosure(
        {
          id: "other-id",
          title: "unrelated onboarding",
          threadIds: ["thread-original-a"],
        },
        closure,
      ),
      true,
    );
    assert.equal(
      matchesClosure(
        {
          id: "other-id",
          title: "Roche anti-TPO pricing contracts",
          threadIds: ["thread-new"],
        },
        closure,
      ),
      true,
    );
    assert.equal(
      matchesClosure(
        {
          id: "other-id",
          title: "pricing",
          threadIds: ["thread-new"],
        },
        closure,
      ),
      false,
    );
  },
);

await check(
  "a new message whose read names a two-word subset does not erase the closure, and the closed threads stay off the board",
  async () => {
    const account = "owner-overlap@example.com";
    await close(account, ["thread-original-a", "thread-original-b"]);
    await close(
      account,
      ["thread-lease"],
      "office lease renewal",
      "matter-office-lease",
    );

    const attacker = mail({
      id: "msg-attacker",
      threadId: "thread-attacker",
      fromEmail: "outside@vendor.example",
      subject: "Need the pricing contract",
      snippet: "Waiting on the pricing contract",
      receivedAt: AFTER,
    });
    const body =
      "This is a live ask. Please send the pricing contract this week. We cannot proceed until you reply.";
    const records = await readEmails(
      [
        {
          id: attacker.id,
          threadId: attacker.threadId,
          fromEmail: attacker.fromEmail,
          fromName: attacker.fromName,
          subject: attacker.subject,
          snippet: attacker.snippet,
          body,
        },
      ],
      {
        functions: ["sales — contracting"],
        fetchBody: async () => body,
      },
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].disposition, "matter");
    assert.equal(records[0].matterTitle, "pricing contract");
    const readCall = globalThis.__seerClosureAi?.calls?.find((call) =>
      call.system.startsWith("You read a CEO's email"),
    );
    assert.ok(readCall, "the deep read never ran");
    assert.match(readCall.system, /matterTitle/);
    assert.match(readCall.prompt, /Please send the pricing contract/);
    const stored = await mergeUnderstanding(account, records);

    const first = await rebuild(account, [attacker], stored);
    const closed = await loadClosedMatters(account);
    const originalA = mail({
      id: "msg-original-a",
      threadId: "thread-original-a",
      fromEmail: "roche@roche.example",
      subject: CLOSED_TITLE,
      receivedAt: BEFORE,
    });
    const originalB = mail({
      id: "msg-original-b",
      threadId: "thread-original-b",
      fromEmail: "roche@roche.example",
      subject: "Roche anti-TPO pricing contract follow up",
      receivedAt: BEFORE,
    });
    const second = await rebuild(
      account,
      [originalA, originalB],
      {
        [originalA.id]: understanding(originalA, "matter", CLOSED_TITLE),
        [originalB.id]: understanding(originalB, "matter", CLOSED_TITLE),
      },
    );
    const back = [...activeThreadIds(second)].sort();
    assert.deepEqual(
      {
        closureKept: Boolean(closed[CLOSED_ID]),
        closedThreads: closed[CLOSED_ID]?.threadIds ?? [],
        unrelatedKept: Boolean(closed["matter-office-lease"]),
        attackerReopened: reopenedThreads(first).includes("thread-attacker"),
        resurrected: back,
      },
      {
        closureKept: true,
        closedThreads: ["thread-original-a", "thread-original-b"],
        unrelatedKept: true,
        attackerReopened: false,
        resurrected: [],
      },
    );
  },
);

await check(
  "a clustered matter whose title is only a subset does not erase the closure",
  async () => {
    const account = "owner-cluster@example.com";
    await close(account, ["thread-original-a"]);
    const attacker = mail({
      id: "msg-cluster",
      threadId: "thread-cluster",
      fromEmail: "outside@vendor.example",
      subject: "pricing contract",
      receivedAt: AFTER,
    });
    // A record is not promoted. Only the clustering loop can match it.
    const map = {
      [attacker.id]: understanding(attacker, "record"),
    };
    const brief = await rebuild(account, [attacker], map, [
      clusterMatter(attacker, "pricing contract"),
    ]);
    const closed = await loadClosedMatters(account);
    assert.ok(closed[CLOSED_ID], "clustered subset title deleted the closure");
    assert.ok(
      !reopenedThreads(brief).includes("thread-cluster"),
      "clustering reopened the closed matter from a different thread",
    );
    assert.ok(
      !activeThreadIds(brief).has("thread-original-a"),
      "the closed thread was placed on the board",
    );
  },
);

await check(
  "newer mail on a different thread does not erase a closure even when the normalized titles are equal",
  async () => {
    const account = "owner-equal@example.com";
    await close(account, ["thread-original-a", "thread-original-b"]);
    const attacker = mail({
      id: "msg-equal",
      threadId: "thread-equal",
      fromEmail: "outside@vendor.example",
      subject: CLOSED_TITLE,
      receivedAt: AFTER,
    });
    const first = await rebuild(
      account,
      [attacker],
      { [attacker.id]: understanding(attacker, "matter", CLOSED_TITLE) },
    );
    const closed = await loadClosedMatters(account);
    assert.ok(
      closed[CLOSED_ID],
      "equal title on a thread that was not closed deleted the closure",
    );
    assert.deepEqual(closed[CLOSED_ID].threadIds, [
      "thread-original-a",
      "thread-original-b",
    ]);
    assert.ok(!reopenedThreads(first).includes("thread-equal"));

    const original = mail({
      id: "msg-original-equal",
      threadId: "thread-original-a",
      fromEmail: "roche@roche.example",
      subject: CLOSED_TITLE,
      receivedAt: BEFORE,
    });
    const second = await rebuild(
      account,
      [original],
      { [original.id]: understanding(original, "matter", CLOSED_TITLE) },
    );
    assert.ok(!activeThreadIds(second).has("thread-original-a"));
  },
);

await check(
  "a longer title that contains the closed words does not erase the closure",
  async () => {
    const account = "owner-superset@example.com";
    await close(account, ["thread-short"], "pricing contract", "matter-short");
    const attacker = mail({
      id: "msg-long",
      threadId: "thread-long",
      fromEmail: "outside@vendor.example",
      subject: CLOSED_TITLE,
      receivedAt: AFTER,
    });
    await rebuild(
      account,
      [attacker],
      { [attacker.id]: understanding(attacker, "matter", CLOSED_TITLE) },
    );
    const closed = await loadClosedMatters(account);
    assert.ok(
      closed["matter-short"],
      "a longer overlapping title deleted the shorter closure",
    );
    assert.deepEqual(closed["matter-short"].threadIds, ["thread-short"]);
  },
);

await check(
  "mail older than the closure does not erase it",
  async () => {
    const account = "owner-older@example.com";
    await close(account, ["thread-original-a"]);
    const attacker = mail({
      id: "msg-older",
      threadId: "thread-older",
      fromEmail: "outside@vendor.example",
      subject: "pricing contract",
      receivedAt: BEFORE,
    });
    await rebuild(
      account,
      [attacker],
      { [attacker.id]: understanding(attacker, "matter", "pricing contract") },
    );
    const closed = await loadClosedMatters(account);
    assert.ok(closed[CLOSED_ID]);
  },
);

await check(
  "a single shared word does not erase the closure",
  async () => {
    const account = "owner-oneword@example.com";
    await close(account, ["thread-original-a"]);
    const attacker = mail({
      id: "msg-one",
      threadId: "thread-one",
      fromEmail: "outside@vendor.example",
      subject: "pricing",
      receivedAt: AFTER,
    });
    const brief = await rebuild(
      account,
      [attacker],
      { [attacker.id]: understanding(attacker, "matter", "pricing") },
    );
    const closed = await loadClosedMatters(account);
    assert.ok(closed[CLOSED_ID]);
    assert.ok(!reopenedThreads(brief).includes("thread-one"));
    assert.ok(
      activeThreadIds(brief).has("thread-one"),
      "a one-word overlap suppressed a distinct live ask",
    );
  },
);

await check(
  "new mail on a thread that belongs to the closure still reopens it",
  async () => {
    const account = "owner-reopen@example.com";
    await close(account, ["thread-original-a", "thread-original-b"]);
    const reply = mail({
      id: "msg-reply",
      threadId: "thread-original-a",
      fromEmail: "roche@roche.example",
      subject: "Re: something else entirely",
      receivedAt: AFTER,
    });
    const brief = await rebuild(
      account,
      [reply],
      {
        [reply.id]: understanding(reply, "matter", "unrelated vendor onboarding"),
      },
    );
    const closed = await loadClosedMatters(account);
    assert.equal(closed[CLOSED_ID], undefined);
    assert.ok(reopenedThreads(brief).includes("thread-original-a"));
    assert.ok(activeThreadIds(brief).has("thread-original-a"));
  },
);

await rm(dataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
