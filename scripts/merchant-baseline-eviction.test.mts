/**
 * Billing-baseline eviction.
 *
 * These tests exercise classifyInboxWithAssistant, the grader the inbox
 * and the sync cron both call. They fail while a flood of first-time
 * senders can delete an older multi-charge biller, and they pass once a
 * later unusual charge from that biller is still raised for review.
 *
 * The model response is produced by the real AI SDK parser. Only the
 * Generative Language HTTP response is local, and its category is
 * deliberately not a money category for the flood. Admission then depends
 * on the subject line the sender chose.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataDir = await fs.mkdtemp(
  path.join(process.cwd(), ".tmp-merchant-baseline-"),
);
process.env.SEER_DATA_DIR = dataDir;
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "placeholder-not-a-secret";
delete process.env.GEMINI_API_KEY;
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
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { loadMerchants } = await import("../src/lib/store/merchants.ts");

const BILLER = "billing@citywater.example";
const BILLER_KEY = "citywater.example";
const USUAL = 140;
const SPIKE = 410;
const PER_LOAD = 160;

type Item = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
};

function bill(id: string, amount: number): Item {
  return {
    id,
    fromEmail: BILLER,
    fromName: "City Water",
    subject: `Monthly invoice $${amount}`,
    snippet: "Account statement for the service period.",
  };
}

function flood(n: number): Item {
  return {
    id: `flood-${n}`,
    fromEmail: `billing@flood-${n}.example`,
    fromName: "Notices",
    subject: "Invoice $9",
    snippet: "A short note.",
  };
}

function collectIds(value: unknown, out: string[], seen: Set<unknown>) {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, out, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && typeof record.email === "string") {
    out.push(record.id);
  }
  for (const entry of Object.values(record)) {
    if (typeof entry === "string") {
      try {
        collectIds(JSON.parse(entry), out, seen);
      } catch {
        /* prompt text that is not JSON */
      }
    } else {
      collectIds(entry, out, seen);
    }
  }
}

function gradeFor(id: string) {
  const established = id.startsWith("bill-") || id.startsWith("spike-");
  return {
    id,
    action: established ? "read_and_archive" : "read_and_delete",
    confidence: 0.9,
    reason: established ? "Paid utility invoice" : "Newsletter",
    instruction: "No action.",
    task: "none",
    category: established ? "Money & bills" : "Newsletter",
    sender: "machine" as const,
    credible: false,
    importance: established ? 1 : 0,
    deed: "none",
  };
}

const realFetch = globalThis.fetch.bind(globalThis);
let modelCalls = 0;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!url.includes("generativelanguage.googleapis.com")) {
    throw new Error(`unexpected outbound request to ${url}`);
  }
  modelCalls += 1;
  const raw =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : input instanceof Request
          ? await input.clone().text()
          : "";
  const ids: string[] = [];
  try {
    collectIds(JSON.parse(raw), ids, new Set());
  } catch {
    throw new Error("model request was not JSON");
  }
  assert.ok(ids.length > 0, "model request contained no triage ids");
  const text = JSON.stringify({ items: ids.map(gradeFor) });
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 10,
        totalTokenCount: 20,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

async function grade(
  accountEmail: string,
  items: Item[],
  deferred?: { runs: Array<() => Promise<void>> },
) {
  return classifyInboxWithAssistant(
    accountEmail,
    items,
    null,
    () => null,
    classifyMessage,
    deferred
      ? {
          deferAi: true,
          onDeferred: (run) => deferred.runs.push(run),
        }
      : undefined,
  );
}

async function gradeAll(accountEmail: string, items: Item[]) {
  for (let i = 0; i < items.length; i += PER_LOAD) {
    await grade(accountEmail, items.slice(i, i + PER_LOAD));
  }
}

const failures: string[] = [];
function check(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  console.log("merchant baseline survives a subject-only sender flood");

  const inlineAccount = "inline-cron@example.com";
  await gradeAll(inlineAccount, [
    bill("bill-1", USUAL),
    bill("bill-2", USUAL),
    bill("bill-3", USUAL),
  ]);
  const before = await loadMerchants(inlineAccount);
  assert.equal(before[BILLER_KEY]?.amounts.length, 3);
  assert.ok(
    before[BILLER_KEY].amounts.every((amount) => amount === USUAL),
    "baseline amounts",
  );

  const control = await grade(inlineAccount, [bill("spike-control", SPIKE)]);
  assert.equal(control.get("spike-control")?.action, "review_subscription");
  assert.match(
    control.get("spike-control")?.reason ?? "",
    /Unusual amount/,
  );

  const kept = await loadMerchants(inlineAccount);
  assert.ok((kept[BILLER_KEY]?.amounts.length ?? 0) >= 3);

  await gradeAll(
    inlineAccount,
    Array.from({ length: 500 }, (_, n) => flood(n)),
  );

  const afterFlood = await loadMerchants(inlineAccount);
  check("inline baseline kept", () => {
    assert.ok(
      afterFlood[BILLER_KEY],
      "multi-charge biller was deleted to store first-time senders",
    );
    assert.ok(
      afterFlood[BILLER_KEY].amounts.length >= 3,
      "multi-charge baseline was replaced by a shorter history",
    );
    assert.ok(
      afterFlood[BILLER_KEY].amounts.filter((amount) => amount === USUAL)
        .length >= 3,
      "the stored usual charges were dropped",
    );
  });

  const later = await grade(inlineAccount, [bill("spike-later", SPIKE)]);
  check("inline later charge", () => {
    assert.equal(
      later.get("spike-later")?.action,
      "review_subscription",
      `later unusual charge was not raised for review (action ${later.get("spike-later")?.action}, reason ${later.get("spike-later")?.reason})`,
    );
    assert.match(later.get("spike-later")?.reason ?? "", /Unusual amount/);
  });

  console.log("mailbox deferred grading has the same eviction");

  const mailboxAccount = "mailbox-refresh@example.com";
  await gradeAll(mailboxAccount, [
    bill("bill-1", USUAL),
    bill("bill-2", USUAL),
    bill("bill-3", USUAL),
  ]);
  await gradeAll(
    mailboxAccount,
    Array.from({ length: 499 }, (_, n) => flood(n)),
  );
  const atCap = await loadMerchants(mailboxAccount);
  assert.equal(atCap[BILLER_KEY]?.amounts.length, 3);
  assert.equal(Object.keys(atCap).length, 500);

  const deferredFlood = { runs: [] as Array<() => Promise<void>> };
  await grade(mailboxAccount, [flood(499)], deferredFlood);
  assert.equal(deferredFlood.runs.length, 1);
  await deferredFlood.runs[0]();

  const afterDeferred = await loadMerchants(mailboxAccount);
  check("deferred baseline kept", () => {
    assert.ok(
      afterDeferred[BILLER_KEY],
      "deferred grading deleted the multi-charge biller",
    );
    assert.ok(
      (afterDeferred[BILLER_KEY]?.amounts.length ?? 0) >= 3,
      "deferred grading shortened the multi-charge baseline",
    );
  });

  const deferredSpike = { runs: [] as Array<() => Promise<void>> };
  await grade(mailboxAccount, [bill("spike-mailbox", SPIKE)], deferredSpike);
  assert.equal(deferredSpike.runs.length, 1);
  await deferredSpike.runs[0]();
  const refreshed = await grade(mailboxAccount, [bill("spike-mailbox", SPIKE)]);
  check("mailbox refresh", () => {
    assert.equal(
      refreshed.get("spike-mailbox")?.action,
      "review_subscription",
      `mailbox refresh missed the unusual-charge review (action ${refreshed.get("spike-mailbox")?.action}, reason ${refreshed.get("spike-mailbox")?.reason})`,
    );
    assert.match(
      refreshed.get("spike-mailbox")?.reason ?? "",
      /Unusual amount/,
    );
  });

  assert.ok(modelCalls > 0, "grader never called the model");
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log("all passed");
} finally {
  globalThis.fetch = realFetch;
  await fs.rm(dataDir, { recursive: true, force: true });
}
