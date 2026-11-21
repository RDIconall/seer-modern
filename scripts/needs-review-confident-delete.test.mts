/**
 * Spec for the confident needs_review → read_and_delete rewrite.
 *
 * These tests fail while that rewrite is still stored and shown.
 * A later fix should make them pass; they are not part of the product.
 *
 * Run: npx tsx scripts/needs-review-confident-delete.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-needs-review-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "placeholder-not-a-real-key";
delete process.env.GEMINI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.POSTGRES_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const AMBIGUOUS =
  "I have been sitting with the spring arrangement and the unsettled sum, and I cannot tell whether it touches your household or a person you care about. I did not want to guess and file it the wrong way.";
const SUBJECT = "A question about the spring arrangement";

type Script = {
  confidence: number;
  reason: string;
  sender?: "person" | "machine";
  credible?: boolean;
};

const scripts = new Map<string, Script>();
const promptRows: { id: string; email: string; snippet: string; rel?: string; sent?: number }[] =
  [];
let modelCalls = 0;

type LabelRecord = { id: string; name: string };
const labelsByName = new Map<string, string>();
const labelNameById = new Map<string, string>();
const messageLabelIds = new Map<string, Set<string>>();
let labelSeq = 1;
let allowModel = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function geminiResponse(items: unknown[]): Response {
  return jsonResponse({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: JSON.stringify({ items }) }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 24,
      totalTokenCount: 36,
    },
  });
}

async function installFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();

    if (
      url.hostname === "generativelanguage.googleapis.com" &&
      url.pathname.endsWith(":generateContent")
    ) {
      if (!allowModel) {
        throw new Error(`model was called after the grade was already stored: ${url.pathname}`);
      }
      modelCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: { parts?: { text?: string }[] }[];
      };
      let raw = "";
      for (const content of body.contents ?? []) {
        for (const part of content.parts ?? []) {
          if (part.text?.trim().startsWith("[")) raw = part.text;
        }
      }
      const rows = JSON.parse(raw) as typeof promptRows;
      promptRows.push(...rows);
      const items = rows.map((row) => {
        const script = scripts.get(row.id);
        if (!script) throw new Error(`no scripted model grade for ${row.id}`);
        return {
          id: row.id,
          action: "needs_review",
          confidence: script.confidence,
          reason: script.reason,
          instruction: "Hold this until a person decides.",
          task: "Decide whether this matters",
          category: "Personal",
          ...(script.sender ? { sender: script.sender } : {}),
          ...(script.credible != null ? { credible: script.credible } : {}),
          importance: 2,
          deed: "none",
        };
      });
      return geminiResponse(items);
    }

    if (url.hostname === "gmail.googleapis.com") {
      if (url.pathname.endsWith("/users/me/labels") && method === "GET") {
        const labels: LabelRecord[] = [...labelsByName.entries()].map(
          ([name, id]) => ({ id, name }),
        );
        return jsonResponse({ labels });
      }
      if (url.pathname.endsWith("/users/me/labels") && method === "POST") {
        const created = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
        if (!created.name) throw new Error("label create had no name");
        const existing = labelsByName.get(created.name);
        const id = existing ?? `Label_${labelSeq++}`;
        labelsByName.set(created.name, id);
        labelNameById.set(id, created.name);
        return jsonResponse({ id, name: created.name });
      }
      if (url.pathname.endsWith("/users/me/messages/batchModify") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          ids?: string[];
          addLabelIds?: string[];
          removeLabelIds?: string[];
        };
        for (const id of body.ids ?? []) {
          const set = messageLabelIds.get(id) ?? new Set<string>();
          for (const add of body.addLabelIds ?? []) set.add(add);
          for (const remove of body.removeLabelIds ?? []) set.delete(remove);
          messageLabelIds.set(id, set);
        }
        return new Response(null, { status: 204 });
      }
    }

    if (typeof realFetch === "function" && url.hostname === "localhost") {
      return realFetch(input, init);
    }
    throw new Error(`unexpected fetch ${method} ${url.hostname}${url.pathname}`);
  };
}

await installFetch();

const { classifyMessage, ACTION_META, needsYouEscape, REFUND_CHECK, APPOINTMENT_HOLD } =
  await import("../src/lib/inbox/classify.ts");
const { historySignals } = await import("../src/lib/inbox/mail-history.ts");
const {
  classifyInboxWithAssistant,
  PROMPT_VERSION,
  getAssistantStatus,
} = await import("../src/lib/inbox/gemini-triage.ts");
const { loadDecisions, clearDecisions } = await import("../src/lib/store/decision-cache.ts");
const { makeGmailLabelStore } = await import("../src/lib/mail/seer-labels.ts");
const { buildActionGuideQuick } = await import("../src/lib/inbox/action-guide.ts");
const { extractAmount } = await import("../src/lib/store/merchants.ts");
const { MACHINE_LOCALPART } = await import("../src/lib/store/people.ts");

const SAFE = new Set(["needs_review", "read_and_archive"]);
const DELETE_GRADE = new Set([
  "read_and_delete",
  "delete_now",
  "unsubscribe",
  "glance_promo",
]);

type Grade = {
  action: string;
  source?: string;
  cached?: boolean;
  reason: string;
  debug: { ruleId: string; relationship: string; sentTo: number };
};

function describeGrade(grade: Grade | undefined): string {
  if (!grade) return "missing";
  return `${grade.action} source=${grade.source} cached=${grade.cached} rule=${grade.debug.ruleId} rel=${grade.debug.relationship} sent=${grade.debug.sentTo} reason=${grade.reason}`;
}

function assertHeld(grade: Grade | undefined, where: string) {
  assert.ok(grade, `${where}: no grade`);
  assert.ok(
    SAFE.has(grade.action),
    `${where}: model needs_review was stored or shown as ${describeGrade(grade)}; want needs_review or read_and_archive`,
  );
}

function assertNotDiscard(grade: Grade | undefined, where: string) {
  assert.ok(grade, `${where}: no grade`);
  assert.equal(
    DELETE_GRADE.has(grade.action),
    false,
    `${where}: ${describeGrade(grade)}`,
  );
}

function readerGuide(
  grade: Grade,
  fromName: string,
) {
  const guide = buildActionGuideQuick(
    grade as Parameters<typeof buildActionGuideQuick>[0],
    SUBJECT,
    fromName,
    AMBIGUOUS,
  );
  const inNeedsReview = guide.action === "needs_review";
  const sectionLabel = ACTION_META[guide.action].label;
  const bulkLabel = ACTION_META[guide.action].bulkLabel;
  return { guide, inNeedsReview, sectionLabel, bulkLabel };
}

function assertReaderDoesNotDiscard(grade: Grade, fromName: string, where: string) {
  assertHeld(grade, where);
  const shown = readerGuide(grade, fromName);
  assert.equal(
    shown.guide.harm.includes("nothing here is load-bearing"),
    false,
    `${where}: reader harm text treats the message as safe to delete (${shown.guide.harm})`,
  );
  assert.equal(shown.sectionLabel === "Read and delete", false, where);
  assert.equal(shown.bulkLabel === "Delete all", false, `${where}: bulk action ${shown.bulkLabel}`);
}

const OWNER = "owner@example.com";
const history = {
  accountEmail: OWNER,
  builtAt: "2026-11-21T00:00:00.000Z",
  contacts: {
    "sam.writer@example.com": {
      email: "sam.writer@example.com",
      sentTo: 4,
      receivedFrom: 4,
    },
    "kept.reader@example.com": {
      email: "kept.reader@example.com",
      sentTo: 0,
      receivedFrom: 2,
      keptFrom: 2,
    },
  },
  engagedCount: 1,
  contactCount: 2,
};

const cold = historySignals(history, "jordan.hale@example.com");
assert.equal(cold.relationship, "cold");
assert.equal(cold.sentTo, 0);
const known = historySignals(history, "kept.reader@example.com");
assert.equal(known.relationship, "known");
assert.equal(known.sentTo, 0);
const bulk = historySignals(history, "noreply@news.example.com");
assert.equal(bulk.relationship, "bulk");
assert.equal(bulk.sentTo, 0);
const engaged = historySignals(history, "sam.writer@example.com");
assert.equal(engaged.relationship, "engaged");
assert.equal(engaged.sentTo, 4);
assert.equal(needsYouEscape(SUBJECT, AMBIGUOUS), false);
assert.equal(REFUND_CHECK.test(`${SUBJECT}\n${AMBIGUOUS}`), false);
assert.equal(APPOINTMENT_HOLD.test(`${SUBJECT}\n${AMBIGUOUS}`), false);
assert.equal(extractAmount(`${SUBJECT}\n${AMBIGUOUS}`), null);
assert.equal(MACHINE_LOCALPART.test("jordan.hale"), false);
assert.equal(MACHINE_LOCALPART.test("noreply"), true);

function item(
  id: string,
  fromEmail: string,
  fromName: string,
  extra?: { labelIds?: string[] },
) {
  return {
    id,
    fromEmail,
    fromName,
    subject: SUBJECT,
    snippet: "Short list preview of the spring arrangement.",
    receivedAt: "2026-11-21T12:00:00.000Z",
    labelIds: extra?.labelIds,
  };
}

const BODY = `${AMBIGUOUS} DEEPBODYTOKEN so the full read is longer than a list preview and is what the grader sends on.`;

function script(id: string, confidence: number, extra?: Partial<Script>) {
  scripts.set(id, {
    confidence,
    reason: `held-for-review ${id}`,
    ...extra,
  });
}

async function gradeInbox(
  account: string,
  rows: ReturnType<typeof item>[],
  opts: {
    geminiEnabled?: boolean;
    defer?: boolean;
    labels: boolean;
  },
) {
  const labels = opts.labels
    ? await makeGmailLabelStore("placeholder-not-a-real-token", account)
    : null;
  assert.ok(!opts.labels || labels, `${account}: Gmail label store unavailable`);
  let deferred: (() => Promise<void>) | null = null;
  const decisions = await classifyInboxWithAssistant(
    account,
    rows,
    history,
    () => null,
    classifyMessage,
    {
      labels,
      geminiEnabled: opts.geminiEnabled !== false,
      fetchBody: async () => BODY,
      ...(opts.defer
        ? {
            deferAi: true,
            onDeferred: (run: () => Promise<void>) => {
              deferred = run;
            },
          }
        : {}),
    },
  );
  if (opts.defer) {
    assert.ok(deferred, "Today/mailbox deferred grade was not scheduled");
    await deferred();
  }
  return { decisions, labels };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.stack ?? e.message : e}`);
  }
}

console.log("needs_review confident delete");

const inlineAccount = "inline@example.com";
const boundaryId = "msg-boundary-055";
const certainId = "msg-certain-100";
const underId = "msg-under-0549";
const knownId = "msg-known-kept";
const bulkId = "msg-bulk";
const engagedId = "msg-engaged";

script(boundaryId, 0.55);
script(certainId, 1);
script(underId, 0.549);
script(knownId, 0.8);
script(bulkId, 0.8);
script(engagedId, 0.9);

const inlineRows = [
  item(boundaryId, "jordan.hale@example.com", "Jordan Hale"),
  item(certainId, "casey.moore@example.com", "Casey Moore"),
  item(underId, "river.quinn@example.com", "River Quinn"),
  item(knownId, "kept.reader@example.com", "Kept Reader"),
  item(bulkId, "noreply@news.example.com", "News"),
  item(engagedId, "sam.writer@example.com", "Sam Writer"),
];

await check("inline grader keeps a confident needs_review for senders never written to", async () => {
  const before = modelCalls;
  const { decisions } = await gradeInbox(inlineAccount, inlineRows, { labels: true });
  assert.equal(modelCalls, before + 1, getAssistantStatus().error ?? "model was not called");
  const prompted = promptRows.filter((row) =>
    [boundaryId, certainId, knownId, bulkId].includes(row.id),
  );
  assert.equal(prompted.length, 4);
  for (const row of prompted) {
    assert.equal(row.sent, undefined);
    assert.notEqual(row.rel, "engaged");
    assert.match(row.snippet, /DEEPBODYTOKEN/);
    assert.match(row.snippet, /unsettled sum/);
  }

  for (const [id, fromName] of [
    [boundaryId, "Jordan Hale"],
    [certainId, "Casey Moore"],
    [knownId, "Kept Reader"],
    [bulkId, "News"],
  ] as const) {
    const grade = decisions.get(id);
    assert.equal(grade?.source, "gemini");
    assert.match(grade?.reason ?? "", /held-for-review/);
    assert.notEqual(grade?.debug.relationship, "engaged");
    assert.equal(grade?.debug.sentTo, 0);
    assertReaderDoesNotDiscard(grade as Grade, fromName, id);
  }

  const under = decisions.get(underId);
  assert.equal(under?.action, "needs_review", describeGrade(under as Grade));
  assert.match(under?.reason ?? "", /held-for-review/);

  const wrote = decisions.get(engagedId);
  assert.equal(wrote?.source, "gemini");
  assert.match(wrote?.reason ?? "", /held-for-review/);
  assert.equal(wrote?.debug.relationship, "engaged");
  assertNotDiscard(wrote as Grade, engagedId);
});

await check("decision cache and Gmail label reuse the held grade, not a delete", async () => {
  const cached = await loadDecisions(
    inlineAccount,
    [boundaryId, certainId, knownId, bulkId, underId],
    PROMPT_VERSION,
  );
  for (const id of [boundaryId, certainId, knownId, bulkId]) {
    const hit = cached.get(id);
    assert.equal(hit?.source, "gemini");
    assert.match(hit?.reason ?? "", /held-for-review/);
    assert.ok(
      hit && SAFE.has(hit.action),
      `${id} cache action ${hit?.action} (model had needs_review)`,
    );
    const names = [...(messageLabelIds.get(id) ?? [])].map((labelId) => labelNameById.get(labelId));
    assert.ok(names.length > 0, `${id}: no Gmail label written`);
    for (const name of names) {
      assert.ok(
        name === "Seer/needs_review" || name === "Seer/read_and_archive",
        `${id}: Gmail label ${name}`,
      );
    }
  }
  assert.equal(cached.get(underId)?.action, "needs_review");
});

await check("the next inbox load trusts the cached model verdict", async () => {
  allowModel = false;
  try {
    const { decisions } = await gradeInbox(inlineAccount, inlineRows, {
      labels: true,
      geminiEnabled: false,
    });
    for (const [id, fromName] of [
      [boundaryId, "Jordan Hale"],
      [certainId, "Casey Moore"],
      [knownId, "Kept Reader"],
      [bulkId, "News"],
    ] as const) {
      const grade = decisions.get(id);
      assert.equal(grade?.cached, true);
      assert.equal(grade?.source, "gemini");
      assert.match(grade?.debug.ruleId ?? "", /^gemini:/);
      assert.match(grade?.reason ?? "", /held-for-review/);
      assertReaderDoesNotDiscard(grade as Grade, fromName, `reload ${id}`);
      const shown = readerGuide(grade as Grade, fromName);
      if (shown.inNeedsReview) {
        assert.equal(shown.sectionLabel, "Needs your call");
      } else {
        assert.equal(shown.sectionLabel, "Read and archive");
      }
    }
  } finally {
    allowModel = true;
  }
});

await check("a Gmail label is the grade when the decision cache is empty", async () => {
  await clearDecisions(inlineAccount);
  allowModel = false;
  try {
    const labeledRows = inlineRows.map((row) => ({
      ...row,
      labelIds: [...(messageLabelIds.get(row.id) ?? [])],
    }));
    const { decisions } = await gradeInbox(inlineAccount, labeledRows, {
      labels: true,
      geminiEnabled: false,
    });
    for (const id of [boundaryId, certainId, knownId, bulkId]) {
      const grade = decisions.get(id);
      assert.equal(grade?.cached, true, describeGrade(grade as Grade));
      assert.equal(grade?.source, "gemini");
      assert.match(grade?.debug.ruleId ?? "", /^label:Seer\//);
      assertHeld(grade as Grade, `label ${id}`);
      assert.equal(
        grade?.debug.ruleId === "label:Seer/needs_review" ||
          grade?.debug.ruleId === "label:Seer/read_and_archive",
        true,
        grade?.debug.ruleId,
      );
    }
  } finally {
    allowModel = true;
  }
});

const personAccount = "person@example.com";
const personId = "msg-credible-person";
script(personId, 0.92, { sender: "person", credible: true });

await check("a credible person the model held back is not saved as delete", async () => {
  const rows = [item(personId, "renee.cole@example.com", "Renee Cole")];
  const { decisions } = await gradeInbox(personAccount, rows, { labels: true });
  const shown = decisions.get(personId);
  assert.equal(shown?.source, "gemini");
  assert.match(shown?.reason ?? "", /held-for-review/);
  assertReaderDoesNotDiscard(shown as Grade, "Renee Cole", "credible person shown");

  const cached = await loadDecisions(personAccount, [personId], PROMPT_VERSION);
  const hit = cached.get(personId);
  assert.equal(hit?.source, "gemini");
  assert.ok(
    hit && SAFE.has(hit.action),
    `credible person cache action ${hit?.action}`,
  );
  const names = [...(messageLabelIds.get(personId) ?? [])].map((id) => labelNameById.get(id));
  assert.ok(names.length > 0, "credible person: no Gmail label");
  for (const name of names) {
    assert.ok(
      name === "Seer/needs_review" || name === "Seer/read_and_archive",
      `credible person label ${name}`,
    );
  }

  allowModel = false;
  try {
    const again = await gradeInbox(personAccount, rows, {
      labels: true,
      geminiEnabled: false,
    });
    const reloaded = again.decisions.get(personId);
    assert.equal(reloaded?.cached, true);
    assert.equal(reloaded?.source, "gemini");
    assertReaderDoesNotDiscard(reloaded as Grade, "Renee Cole", "credible person reload");
  } finally {
    allowModel = true;
  }
});

const todayAccount = "today@example.com";
const todayId = "msg-today-deferred";
script(todayId, 0.55);

await check("Today and mailbox deferred grading stores a held grade for the next load", async () => {
  const rows = [item(todayId, "alex.fern@example.com", "Alex Fern")];
  const first = await gradeInbox(todayAccount, rows, { labels: true, defer: true });
  const provisional = first.decisions.get(todayId);
  assert.equal(provisional?.pending, true);

  const cached = await loadDecisions(todayAccount, [todayId], PROMPT_VERSION);
  const hit = cached.get(todayId);
  assert.equal(hit?.source, "gemini");
  assert.match(hit?.reason ?? "", /held-for-review/);
  assert.ok(hit && SAFE.has(hit.action), `deferred cache action ${hit?.action}`);
  const names = [...(messageLabelIds.get(todayId) ?? [])].map((id) => labelNameById.get(id));
  assert.ok(names.length > 0, "deferred: no Gmail label");
  for (const name of names) {
    assert.ok(
      name === "Seer/needs_review" || name === "Seer/read_and_archive",
      `deferred label ${name}`,
    );
  }

  allowModel = false;
  try {
    const second = await gradeInbox(todayAccount, rows, {
      labels: true,
      geminiEnabled: false,
    });
    const grade = second.decisions.get(todayId);
    assert.equal(grade?.cached, true);
    assert.equal(grade?.source, "gemini");
    assert.match(grade?.reason ?? "", /held-for-review/);
    assert.match(grade?.debug.ruleId ?? "", /^gemini:/);
    assertReaderDoesNotDiscard(grade as Grade, "Alex Fern", "next Today load");
  } finally {
    allowModel = true;
  }
});

const outlookAccount = "outlook@example.com";
const outlookId = "msg-outlook-inline";
script(outlookId, 0.77);

await check("a mailbox without Gmail labels still caches the held grade", async () => {
  const rows = [item(outlookId, "morgan.lee@example.com", "Morgan Lee")];
  const { decisions } = await gradeInbox(outlookAccount, rows, { labels: false });
  const shown = decisions.get(outlookId);
  assert.equal(shown?.source, "gemini");
  assert.match(shown?.reason ?? "", /held-for-review/);
  assertReaderDoesNotDiscard(shown as Grade, "Morgan Lee", "outlook shown");
  const cached = await loadDecisions(outlookAccount, [outlookId], PROMPT_VERSION);
  assert.ok(
    cached.get(outlookId) && SAFE.has(cached.get(outlookId)!.action),
    `outlook cache ${cached.get(outlookId)?.action}`,
  );

  allowModel = false;
  try {
    const second = await gradeInbox(outlookAccount, rows, {
      labels: false,
      geminiEnabled: false,
    });
    const grade = second.decisions.get(outlookId);
    assert.equal(grade?.cached, true);
    assert.equal(grade?.source, "gemini");
    assertReaderDoesNotDiscard(grade as Grade, "Morgan Lee", "outlook reload");
  } finally {
    allowModel = true;
  }
});

await rm(dataDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
