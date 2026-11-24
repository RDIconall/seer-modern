/**
 * Sender domains that collide with built-in object keys must not throw
 * while inbox billing memory is read, and must not stop Gemini grading
 * for the rest of the mailbox.
 *
 * These tests fail while that bug is present. They pass once merchant
 * history ignores inherited properties and one bad sender cannot abort
 * grading for later messages.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-merchants-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
process.env.SEER_GEMINI_DEEP_BATCH = "4";
process.env.SEER_GEMINI_BATCH_SIZE = "5";
process.env.GEMINI_API_KEY = "test-only-placeholder";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const {
  PROMPT_VERSION,
  classifyInboxWithAssistant,
  getAssistantStatus,
} = await import("../src/lib/inbox/gemini-triage.ts");
const { getGmailMessage, listGmailFolder } = await import(
  "../src/lib/mail/gmail.ts"
);
const { listGraphFolder } = await import("../src/lib/mail/graph.ts");
const { loadDecisions } = await import("../src/lib/store/decision-cache.ts");
const {
  isAnomalousCharge,
  loadMerchants,
  recordCharge,
  saveMerchants,
  usualLabel,
} = await import("../src/lib/store/merchants.ts");

const PLACEHOLDER_TOKEN = "test-only-placeholder";
const OWN_DOMAIN = "shop.example";

type Header = { name: string; value: string };

function gmailMessage(input: {
  id: string;
  from: string;
  subject: string;
  snippet: string;
}) {
  return {
    id: input.id,
    threadId: `thread-${input.id}`,
    snippet: input.snippet,
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: "owner@mailbox.test" },
        { name: "Subject", value: input.subject },
      ] satisfies Header[],
    },
  };
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function hydrateGmail(
  messages: ReturnType<typeof gmailMessage>[],
) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const restore = installFetch((url) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "gmail.googleapis.com") {
      return new Response("unexpected host", { status: 500 });
    }
    if (parsed.pathname.endsWith("/messages")) {
      return Response.json({
        messages: messages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
      });
    }
    const id = parsed.pathname.split("/").pop() ?? "";
    const message = byId.get(id);
    if (!message) return new Response("missing", { status: 404 });
    return Response.json(message);
  });
  try {
    return await listGmailFolder(PLACEHOLDER_TOKEN, "inbox", messages.length);
  } finally {
    restore();
  }
}

async function hydrateGraph(address: string) {
  const restore = installFetch((url) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "graph.microsoft.com") {
      return new Response("unexpected host", { status: 500 });
    }
    return Response.json({
      value: [
        {
          id: "graph-1",
          conversationId: "graph-thread-1",
          subject: "Invoice for $42.00",
          bodyPreview: "Amount due $42.00",
          receivedDateTime: new Date().toISOString(),
          isRead: false,
          from: { emailAddress: { name: "Attacker", address } },
        },
      ],
    });
  });
  try {
    const [item] = await listGraphFolder(PLACEHOLDER_TOKEN, "inbox", 1);
    return item;
  } finally {
    restore();
  }
}

function modelReply(ids: string[]) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                items: ids.map((id) => ({
                  id,
                  action: "read_and_archive",
                  confidence: 0.91,
                  reason: "Recorded for the test double",
                  instruction: "File it",
                  task: "none",
                  category: "finance",
                  sender: "machine",
                  credible: false,
                  importance: 1,
                  deed: "none",
                })),
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 10,
      totalTokenCount: 20,
    },
  };
}

function idsInModelRequest(body: string): string[] {
  return [...body.matchAll(/case-[a-z0-9-]+/g)].map((match) => match[0]);
}

function installModelFetch() {
  const requests: string[] = [];
  const restore = installFetch((url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "generativelanguage.googleapis.com") {
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push(body);
      const ids = [...new Set(idsInModelRequest(body))];
      return Response.json(modelReply(ids));
    }
    return new Response("unexpected host", { status: 500 });
  });
  return { requests, restore };
}

type Listed = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  labelIds?: string[];
  threadId?: string;
  receivedAt: string;
};

async function grade(
  accountEmail: string,
  items: Listed[],
  mode: "inline" | "deferred",
) {
  const { restore } = installModelFetch();
  try {
    let deferred: (() => Promise<void>) | undefined;
    const results = await classifyInboxWithAssistant(
      accountEmail,
      items.map((item) => ({
        id: item.id,
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
        labelIds: item.labelIds,
        threadId: item.threadId,
        receivedAt: item.receivedAt,
      })),
      null,
      async () => null,
      classifyMessage,
      {
        geminiEnabled: true,
        fetchBody: async () => "Short body.",
        ...(mode === "deferred"
          ? {
              deferAi: true,
              onDeferred: (run: () => Promise<void>) => {
                deferred = run;
              },
            }
          : {}),
      },
    );
    if (mode === "deferred") {
      assert.ok(deferred, "deferred grading was scheduled");
      await deferred();
    }
    return results;
  } finally {
    restore();
  }
}

async function assertGradedAndCached(
  results: Awaited<ReturnType<typeof grade>>,
  accountEmail: string,
  ids: string[],
  mode: "inline" | "deferred",
) {
  const cached = await loadDecisions(accountEmail, ids, PROMPT_VERSION);
  const status = getAssistantStatus().error ?? "none";
  for (const id of ids) {
    if (mode === "inline") {
      const gradeResult = results.get(id);
      assert.equal(
        gradeResult?.source,
        "gemini",
        `${id} source=${gradeResult?.source ?? "missing"} error=${status}`,
      );
    }
    assert.equal(
      cached.get(id)?.source,
      "gemini",
      `${id} cache=${cached.get(id)?.source ?? "missing"} error=${status}`,
    );
  }
}

async function withInheritedAmounts<T>(run: () => Promise<T> | T): Promise<T> {
  const proto = Object.prototype as { amounts?: number[] };
  const previous = Object.getOwnPropertyDescriptor(proto, "amounts");
  Object.defineProperty(proto, "amounts", {
    configurable: true,
    writable: true,
    value: [100, 200, 300],
  });
  const objectAmounts = Object.getOwnPropertyDescriptor(Object, "amounts");
  Object.defineProperty(Object, "amounts", {
    configurable: true,
    writable: true,
    value: [100, 200, 300],
  });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(proto, "amounts", previous);
    else delete proto.amounts;
    if (objectAmounts) Object.defineProperty(Object, "amounts", objectAmounts);
    else delete (Object as { amounts?: number[] }).amounts;
  }
}

console.log("merchant prototype keys");

const controlItems: Listed[] = [1, 2].map((n) => ({
  id: `case-control-${n}`,
  fromEmail: `control${n}@${OWN_DOMAIN}`,
  fromName: `Control ${n}`,
  subject: "Weekly update",
  snippet: "Nothing unusual",
  threadId: `thread-control-${n}`,
  receivedAt: new Date().toISOString(),
  labelIds: ["INBOX"],
}));
const control = await grade("control@mailbox.test", controlItems, "inline");
await assertGradedAndCached(
  control,
  "control@mailbox.test",
  controlItems.map((item) => item.id),
  "inline",
);
console.log("model double graded a clean inbox");

const quotedProto = `"x@__proto__@y"@attacker.example`;
const quotedConstructor = `Attacker <"x@constructor@y"@attacker.example>`;
const graphAddress = `"x@__proto__@y"@attacker.example`;

const protoList = await hydrateGmail([
  gmailMessage({
    id: "hydrate-proto",
    from: quotedProto,
    subject: "Invoice for $42.00",
    snippet: "Amount due $42.00",
  }),
]);
assert.equal(protoList.length, 1);
const protoEmail = protoList[0].fromEmail;

const constructorDetail = await (async () => {
  const message = gmailMessage({
    id: "hydrate-constructor",
    from: quotedConstructor,
    subject: "Invoice for $42.00",
    snippet: "Amount due $42.00",
  });
  const restore = installFetch((url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/hydrate-constructor")) {
      return new Response("unexpected", { status: 500 });
    }
    return Response.json(message);
  });
  try {
    return await getGmailMessage(PLACEHOLDER_TOKEN, "hydrate-constructor");
  } finally {
    restore();
  }
})();

const graphItem = await hydrateGraph(graphAddress);
const poisonedEmails = [protoEmail, constructorDetail.fromEmail, graphItem.fromEmail];

for (const email of poisonedEmails) {
  const loaded = await loadMerchants(`owner-${email.length}@mailbox.test`);
  assert.equal(usualLabel(loaded, email), null);
  assert.equal(isAnomalousCharge(loaded, email, 500), false);
  const beforeNames = Object.getOwnPropertyNames(Object.prototype).sort();
  recordCharge(loaded, email, "Attacker", 42);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.prototype).sort(),
    beforeNames,
  );
  const prototype = Object.getPrototypeOf(loaded);
  assert.ok(prototype === Object.prototype || prototype === null);
  assert.equal((Object.prototype as { amounts?: unknown }).amounts, undefined);
  assert.equal(usualLabel(JSON.parse("{}"), email), null);
  recordCharge(loaded, `billing@${OWN_DOMAIN}`, "Shop", 20);
  recordCharge(loaded, `billing@${OWN_DOMAIN}`, "Shop", 30);
  assert.equal(
    usualLabel(loaded, `billing@${OWN_DOMAIN}`),
    "usually ~$30 (2 charges)",
  );
  assert.equal(
    usualLabel(JSON.parse("{}"), `billing@${OWN_DOMAIN}`),
    null,
  );
}

await withInheritedAmounts(async () => {
  for (const email of poisonedEmails) {
    const db = await loadMerchants("inherited@mailbox.test");
    assert.equal(usualLabel(db, email), null);
    assert.equal(isAnomalousCharge(db, email, 1000), false);
    const sentinel = [5, 6];
    (Object.prototype as { amounts: number[] }).amounts = sentinel;
    (Object as { amounts: number[] }).amounts = [5, 6];
    recordCharge(db, email, "Attacker", 99);
    assert.deepEqual(sentinel, [5, 6]);
    assert.deepEqual((Object as { amounts: number[] }).amounts, [5, 6]);
  }
});

const stored = JSON.parse(
  JSON.stringify({
    [OWN_DOMAIN]: {
      key: OWN_DOMAIN,
      name: "Shop",
      amounts: [10, 20, 40],
      count: 3,
      lastAt: "2026-01-01T00:00:00.000Z",
    },
  }),
);
assert.equal(usualLabel(stored, protoEmail), null);
assert.equal(isAnomalousCharge(stored, protoEmail, 1000), false);
assert.equal(usualLabel(stored, `billing@${OWN_DOMAIN}`), "usually ~$20 (3 charges)");
assert.equal(isAnomalousCharge(stored, `billing@${OWN_DOMAIN}`, 100), true);
await saveMerchants("roundtrip@mailbox.test", stored);
const roundTrip = await loadMerchants("roundtrip@mailbox.test");
assert.equal(
  usualLabel(roundTrip, `billing@${OWN_DOMAIN}`),
  "usually ~$20 (3 charges)",
);

function batchFrom(poisonFrom: string, poisonName: string, tag: string): Listed[] {
  const poison: Listed = {
    id: `case-poison-${tag}`,
    fromEmail: poisonFrom,
    fromName: poisonName,
    subject: "Invoice for $42.00",
    snippet: "Amount due $42.00",
    threadId: `thread-poison-${tag}`,
    receivedAt: new Date().toISOString(),
    labelIds: ["INBOX"],
  };
  const siblings = [1, 2, 3].map((n) => ({
    id: `case-sib-${tag}-${n}`,
    fromEmail: `person${n}@${OWN_DOMAIN}`,
    fromName: `Person ${n}`,
    subject: "Notes from the meeting",
    snippet: "See you next week",
    threadId: `thread-sib-${tag}-${n}`,
    receivedAt: new Date().toISOString(),
    labelIds: ["INBOX"],
  }));
  const later: Listed = {
    id: `case-later-${tag}`,
    fromEmail: `later@${OWN_DOMAIN}`,
    fromName: "Later Sender",
    subject: "Project notes",
    snippet: "The draft is attached",
    threadId: `thread-later-${tag}`,
    receivedAt: new Date().toISOString(),
    labelIds: ["INBOX"],
  };
  return [poison, ...siblings, later];
}

for (const [tag, email, name] of [
  ["proto", protoEmail, protoList[0].fromName],
  ["ctor", constructorDetail.fromEmail, constructorDetail.fromName],
  ["graph", graphItem.fromEmail, graphItem.fromName],
] as const) {
  for (const mode of ["inline", "deferred"] as const) {
    const account = `${mode}-${tag}@mailbox.test`;
    const items = batchFrom(email, name, `${mode}-${tag}`);
    const results = await grade(account, items, mode);
    const innocent = items.slice(1).map((item) => item.id);
    await assertGradedAndCached(results, account, innocent, mode);
    assert.equal(results.has(items[0].id), true);
    const again = await loadDecisions(account, innocent, PROMPT_VERSION);
    for (const id of innocent) assert.equal(again.has(id), true);
  }
}

await rm(dataDir, { recursive: true, force: true });
console.log("all passed");
