/**
 * Keyword urgency must not promote a stranger's mail into Act today.
 *
 * These tests fail while a subject or preview phrase such as "fraud",
 * "dispute", "new invoice", "password reset", "vulnerability", or
 * "sent you a message" skips a taught or learned mute and forces
 * Act today. They pass once those phrases are only hints: a mute stays
 * a mute, and Act today is not forced, unless the sender is already
 * someone the mailbox owner knows. A bare word is not enough on its own.
 *
 * Run:
 *   npx tsx scripts/keyword-urgency-mute-bypass.test.mts
 *
 * The grader under test is classifyInboxWithAssistant, the function
 * Today, the mailbox, the brief, catch-up, the reader, all-tasks, and
 * the sync cron all call with classifyMessage as the rules fallback.
 * Storage is a temp directory. Gemini is not called.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TriageAction } from "../src/lib/inbox/classify.ts";
import type { MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { PersonalContext } from "../src/lib/inbox/personal-context.ts";
import type { ActionMemory } from "../src/lib/store/action-memory.ts";
import type { SeerLabelStore } from "../src/lib/mail/seer-labels.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "seer-urgency-"));
process.env.SEER_DATA_DIR = dataDir;
for (const key of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
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
  delete process.env[key];
}

const { classifyMessage, ACTION_META, TODAY_SECTION_ORDER } = await import(
  "../src/lib/inbox/classify.ts"
);
const { classifyInboxWithAssistant, PROMPT_VERSION } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { saveDecisions } = await import("../src/lib/store/decision-cache.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");

const OWNER = "owner@example.com";
const STRANGER = "phish@evil.test";
const FRIEND = "friend@gmail.com";

/** Catch-up treats these actions as work that needs the user. */
const CATCHUP_NEEDS = new Set([
  "respond",
  "act_today",
  "needs_review",
  "review_subscription",
]);

const PHRASES = [
  "Fraud",
  "Dispute",
  "New invoice",
  "Password reset",
  "Vulnerability",
  "sent you a message",
] as const;

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
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

function historyFor(sent: Record<string, number>): MailHistory {
  const contacts: MailHistory["contacts"] = {};
  for (const [email, sentTo] of Object.entries(sent)) {
    contacts[email] = {
      email,
      sentTo,
      receivedFrom: 1,
      lastSentAt: new Date().toISOString(),
    };
  }
  return {
    accountEmail: OWNER,
    builtAt: new Date().toISOString(),
    contacts,
    engagedCount: Object.keys(contacts).length,
    contactCount: Object.keys(contacts).length,
  };
}

function memory(
  email: string,
  action: "archive" | "trash",
  count = 4,
): ActionMemory {
  return {
    [email.toLowerCase()]: {
      archive: action === "archive" ? count : 0,
      trash: action === "trash" ? count : 0,
      lastAt: new Date().toISOString(),
    },
  };
}

let seq = 0;
async function grade(input: {
  account?: string;
  from?: string;
  subject: string;
  snippet?: string;
  override?: TriageAction | null;
  memory?: ActionMemory | null;
  history?: MailHistory | null;
  personal?: PersonalContext | null;
  labels?: SeerLabelStore | null;
  labelIds?: string[];
  deferAi?: boolean;
}) {
  const id = `m${++seq}`;
  const account = input.account ?? `${OWNER}`;
  const from = input.from ?? STRANGER;
  const subject = input.subject;
  const snippet = input.snippet ?? "";
  let deferred: (() => Promise<void>) | null = null;
  const decisions = await classifyInboxWithAssistant(
    account,
    [
      {
        id,
        fromEmail: from,
        fromName: "Outside sender",
        subject,
        snippet,
        threadId: `thread-${id}`,
        receivedAt: new Date().toISOString(),
        labelIds: input.labelIds,
      },
    ],
    input.history ?? null,
    () => input.override ?? null,
    classifyMessage,
    {
      geminiEnabled: input.deferAi ? undefined : false,
      actionMemory: input.memory ?? null,
      personal: input.personal ?? null,
      labels: input.labels,
      deferAi: input.deferAi ?? false,
      onDeferred: input.deferAi
        ? (run) => {
            deferred = run;
          }
        : undefined,
    },
  );
  const result = decisions.get(id);
  assert.ok(result, `grader returned no decision for ${subject}`);
  return { id, from, subject, snippet, result: result!, deferred };
}

function describe(result: {
  action: string;
  confidence: string;
  source: string;
  debug: { ruleId: string };
}) {
  return `${result.action}/${result.confidence} source=${result.source} rule=${result.debug.ruleId}`;
}

/**
 * Same bucketing as src/app/api/today/route.ts: Act today is its own
 * section, labeled from ACTION_META.
 */
function actTodaySectionIds(
  rows: { id: string; action: TriageAction }[],
): { label: string; ids: string[] } | null {
  const byAction = new Map<TriageAction, string[]>();
  for (const row of rows) {
    const list = byAction.get(row.action) ?? [];
    list.push(row.id);
    byAction.set(row.action, list);
  }
  const sections = TODAY_SECTION_ORDER.filter(
    (action) => action !== "needs_review" && (byAction.get(action)?.length ?? 0) > 0,
  ).map((action) => ({
    action,
    label: ACTION_META[action].label,
    ids: byAction.get(action) ?? [],
  }));
  const urgent = sections.find((section) => section.action === "act_today");
  return urgent ? { label: urgent.label, ids: urgent.ids } : null;
}

console.log("keyword urgency mute bypass");

await check("a taught delete holds when the subject has no urgency phrase", async () => {
  const { result } = await grade({
    subject: "Weekly roundup",
    snippet: "A few links from last week",
    override: "delete_now",
  });
  assert.equal(result.action, "delete_now", describe(result));
  assert.equal(result.source, "override", describe(result));
});

await check("a learned delete holds when the subject has no urgency phrase", async () => {
  const { result } = await grade({
    from: "lists@news.test",
    subject: "Weekly roundup",
    snippet: "A few links from last week",
    memory: memory("lists@news.test", "trash"),
  });
  assert.equal(result.action, "delete_now", describe(result));
  assert.equal(result.source, "learned", describe(result));
});

for (const phrase of PHRASES) {
  await check(
    `taught delete is not skipped for a stranger subject "${phrase}"`,
    async () => {
      const { id, result, subject, snippet, from } = await grade({
        subject: phrase,
        snippet: "Open the link in this message",
        override: "delete_now",
      });
      assert.equal(result.action, "delete_now", describe(result));
      assert.equal(result.source, "override", describe(result));

      const guide = buildActionGuideQuick(result, subject, "Outside sender", snippet);
      assert.notEqual(guide.action, "act_today");
      assert.notEqual(guide.label, "Act today");
      assert.equal(CATCHUP_NEEDS.has(guide.action), false, describe(result));

      const section = actTodaySectionIds([{ id, action: guide.action }]);
      assert.equal(section, null, `Today would file ${from} under Act today`);
    },
  );
}

await check("taught archive is not skipped for a stranger subject \"New invoice\"", async () => {
  const { result } = await grade({
    subject: "New invoice",
    snippet: "See the attached file",
    override: "read_and_archive",
  });
  assert.equal(result.action, "read_and_archive", describe(result));
  assert.equal(result.source, "override", describe(result));
});

await check("learned delete is not skipped for a stranger subject \"Dispute\"", async () => {
  const { result } = await grade({
    subject: "Dispute",
    snippet: "See the attached file",
    memory: memory(STRANGER, "trash"),
  });
  assert.equal(result.action, "delete_now", describe(result));
  assert.equal(result.source, "learned", describe(result));
});

await check("learned archive is not skipped for a stranger subject \"Fraud\"", async () => {
  const { result } = await grade({
    subject: "Fraud",
    memory: memory(STRANGER, "archive"),
  });
  assert.equal(result.action, "read_and_archive", describe(result));
  assert.equal(result.source, "learned", describe(result));
});

await check("the urgency phrase in the preview is enough to try the bypass", async () => {
  const { result } = await grade({
    subject: "Hello",
    snippet: "Your password reset is waiting",
    override: "delete_now",
  });
  assert.equal(result.action, "delete_now", describe(result));
  assert.equal(result.source, "override", describe(result));
});

await check(
  "a quiet cached read is not replaced with Act today at high confidence",
  async () => {
    const account = "cache-owner@example.com";
    const id = "cached-quiet";
    await saveDecisions(
      account,
      new Map([
        [
          id,
          {
            action: "delete_now",
            confidence: "HIGH",
            reason: "Phishing, nothing to do",
            source: "gemini",
            ruleId: "gemini:quiet-read",
            ts: Date.now(),
            v: PROMPT_VERSION,
          },
        ],
      ]),
    );
    seq = 0;
    const decisions = await classifyInboxWithAssistant(
      account,
      [
        {
          id,
          fromEmail: STRANGER,
          fromName: "Outside sender",
          subject: "Vulnerability",
          snippet: "Open this security notice",
          threadId: "thread-cached-quiet",
          receivedAt: new Date().toISOString(),
        },
      ],
      null,
      () => "delete_now",
      classifyMessage,
      { geminiEnabled: false },
    );
    const result = decisions.get(id);
    assert.ok(result);
    assert.equal(result.action, "delete_now", describe(result));
    assert.equal(result.source, "override", describe(result));
    assert.equal(result.debug.ruleId.includes("needs-you-floor"), false, describe(result));
  },
);

await check("a saved delete label is not promoted to Act today by \"Fraud\"", async () => {
  const account = "label-owner@example.com";
  await kvSet(`labels-era:${account}`, PROMPT_VERSION);
  const labels: SeerLabelStore = {
    lookup: (item) => (item.labelIds?.includes("Label_delete") ? "delete_now" : null),
    persist: async () => {},
  };
  const { result } = await grade({
    account,
    subject: "Fraud",
    snippet: "Open the notice",
    labels,
    labelIds: ["Label_delete"],
  });
  assert.notEqual(result.action, "act_today", describe(result));
  assert.equal(result.debug.ruleId.includes("needs-you-floor"), false, describe(result));
});

await check("a cached rules delete is not promoted to Act today by \"New invoice\"", async () => {
  const account = "rules-cache-owner@example.com";
  const id = "cached-rules";
  await saveDecisions(
    account,
    new Map([
      [
        id,
        {
          action: "delete_now",
          confidence: "HIGH",
          reason: "You always delete this",
          source: "rules",
          ruleId: "noreply-cold-delete",
          ts: Date.now(),
          v: PROMPT_VERSION,
        },
      ],
    ]),
  );
  const decisions = await classifyInboxWithAssistant(
    account,
    [
      {
        id,
        fromEmail: "noreply@evil.test",
        fromName: "Billing",
        subject: "New invoice",
        snippet: "See the attached file",
        threadId: "thread-cached-rules",
        receivedAt: new Date().toISOString(),
      },
    ],
    null,
    () => null,
    classifyMessage,
    { geminiEnabled: false },
  );
  const result = decisions.get(id);
  assert.ok(result);
  assert.notEqual(result.action, "act_today", describe(result));
  assert.equal(result.debug.ruleId.includes("needs-you-floor"), false, describe(result));
});

await check("rules do not force Act today for a cold sender before considering them", async () => {
  const problems: string[] = [];
  for (const phrase of ["Fraud", "Dispute", "New invoice", "Password reset"] as const) {
    const result = classifyMessage(
      {
        fromEmail: STRANGER,
        fromName: "Accounts",
        subject: phrase,
        snippet: "Please act on this message",
      },
      null,
      null,
    );
    if (result.action === "act_today" || result.debug.relationship !== "cold") {
      problems.push(`${phrase}: ${result.action} ${result.debug.ruleId}`);
    }
    for (const rule of [
      "money-risk-act",
      "finance-needs-you",
      "bill-due-pay",
      "transactional-urgent",
    ]) {
      if (result.debug.ruleId === rule) problems.push(`${phrase}: ${rule}`);
    }
  }
  assert.deepEqual(problems, []);
});

await check("a product-domain word does not force Act today from an unknown sender", async () => {
  const vulnerability = classifyMessage(
    {
      fromEmail: "notifications@github.com",
      subject: "Vulnerability",
      snippet: "Details inside",
    },
    null,
    null,
  );
  assert.notEqual(vulnerability.action, "act_today", vulnerability.debug.ruleId);
  assert.notEqual(vulnerability.debug.ruleId, "product-needs-you");

  const dm = classifyMessage(
    {
      fromEmail: "notifications@slack.com",
      subject: "Alex sent you a message",
      snippet: "Open Slack to read it",
    },
    null,
    null,
  );
  assert.notEqual(dm.action, "act_today", dm.debug.ruleId);
  assert.notEqual(dm.debug.ruleId, "product-needs-you");
});

await check("the bare word fraud does not pierce a mute even for someone you know", async () => {
  const { result } = await grade({
    from: FRIEND,
    subject: "Fraud",
    snippet: "Take a look",
    override: "delete_now",
    history: historyFor({ [FRIEND]: 4 }),
  });
  assert.equal(result.action, "delete_now", describe(result));
  assert.equal(result.source, "override", describe(result));
});

await check("password reset from someone you already write to can still be Act today", async () => {
  const { result } = await grade({
    from: FRIEND,
    subject: "Password reset",
    snippet: "Use this to finish resetting the account you asked about",
    history: historyFor({ [FRIEND]: 4 }),
  });
  assert.equal(result.action, "act_today", describe(result));
});

await check("Today's first paint still uses the phrase when Gemini is deferred", async () => {
  process.env.VERCEL = "1";
  try {
    const { result, deferred } = await grade({
      subject: "New invoice",
      snippet: "Pay this today",
      override: "delete_now",
      deferAi: true,
    });
    assert.equal(deferred === null, false);
    assert.equal(result.action, "delete_now", describe(result));
    assert.equal(result.source, "override", describe(result));
    const guide = buildActionGuideQuick(
      result,
      "New invoice",
      "Outside sender",
      "Pay this today",
    );
    assert.notEqual(guide.label, "Act today");
    assert.notEqual(guide.task, "Handle it today");
  } finally {
    delete process.env.VERCEL;
  }
});

console.log(
  failures === 0
    ? "keyword urgency mute bypass: ok"
    : `keyword urgency mute bypass: ${failures} failed`,
);
if (failures > 0) process.exit(1);
