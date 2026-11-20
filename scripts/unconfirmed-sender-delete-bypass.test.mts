/**
 * Unconfirmed sender judgment must not block deletion.
 *
 * These tests exercise classifyInboxWithAssistant, the grader the signed-in
 * inbox, today, cron, and all-tasks loads run. They fail while a single model
 * reading of attacker-written mail can persist a person tier, and while that
 * tier (or inbound volume alone) rewrites a delete into a keep.
 *
 * Run: npx tsx scripts/unconfirmed-sender-delete-bypass.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-people-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.GEMINI_API_KEY = "placeholder";
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const {
  classifyInboxWithAssistant,
  PROMPT_VERSION,
} = await import("../src/lib/inbox/gemini-triage.ts");
const { buildMailHistory } = await import("../src/lib/inbox/mail-history.ts");
const { loadPeople, savePeople } = await import("../src/lib/store/people.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");
import type { TriageAction } from "../src/lib/inbox/classify.ts";
import type { GeminiTriageItem, TriageExtras } from "../src/lib/inbox/gemini-triage.ts";
import type { MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";
import type { PersonalContext } from "../src/lib/inbox/personal-context.ts";

type Verdict = {
  action: TriageAction;
  sender: "person" | "machine";
  credible: boolean;
};

const DELETEY = new Set<TriageAction>([
  "delete_now",
  "read_and_delete",
  "unsubscribe",
  "glance_promo",
]);

const verdicts = new Map<string, Verdict>();
const prompts: string[] = [];
let failModel = false;
let modelCalls = 0;

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return "";
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathOnly = url.split("?")[0] ?? url;
  if (!pathOnly.endsWith(":generateContent")) {
    throw new Error(`unexpected fetch ${pathOnly}`);
  }
  modelCalls += 1;
  const prompt = bodyText(init?.body);
  prompts.push(prompt);
  if (failModel) {
    return new Response(JSON.stringify({ error: { message: "model offline" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const items = [];
  for (const [id, verdict] of verdicts) {
    if (!prompt.includes(id)) continue;
    items.push({
      id,
      action: verdict.action,
      confidence: 0.91,
      reason:
        verdict.sender === "person"
          ? "Specific ask about a real project"
          : "No consequence for the reader",
      instruction: "Graded from the message text.",
      task: "none",
      category: "Work",
      sender: verdict.sender,
      credible: verdict.credible,
      importance: DELETEY.has(verdict.action) ? 0 : 2,
      deed: "none",
    });
  }
  const text = JSON.stringify({ items });
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text }], role: "model" },
          finishReason: "STOP",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const ASK =
  "Could you look at the Harbor project lease and tell me if the zoning workaround still holds for the parcel on 4th street?";
const PROMO = "Flash deal: 50% off new arrivals. Shop now. Limited time sale.";

const failures: string[] = [];

function check(name: string, run: () => void | Promise<void>) {
  return Promise.resolve()
    .then(run)
    .then(() => {
      console.log(`ok  ${name}`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL ${name}: ${message}`);
    });
}

function row(id: string, fromEmail: string, subject: string, snippet: string): MailMessageListItem {
  return {
    id,
    threadId: `thread-${id}`,
    fromEmail,
    fromName: "Alex Chen",
    subject,
    snippet,
    receivedAt: new Date().toISOString(),
    isUnread: true,
  };
}

function item(rowItem: MailMessageListItem): GeminiTriageItem {
  return {
    id: rowItem.id,
    fromEmail: rowItem.fromEmail,
    fromName: rowItem.fromName,
    subject: rowItem.subject,
    snippet: rowItem.snippet,
    threadId: rowItem.threadId,
    receivedAt: rowItem.receivedAt,
  };
}

function historyFor(
  account: string,
  rows: MailMessageListItem[],
  sent: MailMessageListItem[] = [],
): MailHistory {
  return buildMailHistory(account, rows, sent, []);
}

async function grade(
  account: string,
  rows: MailMessageListItem[],
  extras?: TriageExtras,
  history?: MailHistory,
  getOverride?: (email: string) => TriageAction | null,
) {
  return classifyInboxWithAssistant(
    account,
    rows.map(item),
    history ?? historyFor(account, rows),
    getOverride ?? (() => null),
    classifyMessage,
    {
      fetchBody: async (id) => rows.find((r) => r.id === id)?.snippet ?? null,
      ...extras,
    },
  );
}

function protecting(record: { tier?: string; vip?: boolean } | undefined): boolean {
  if (!record) return false;
  return (
    record.vip === true ||
    record.tier === "new-credible" ||
    record.tier === "inner" ||
    record.tier === "known"
  );
}

await check("attacker text is what the grader sends the model", async () => {
  const account = "text-reaches-model@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-1", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  const before = prompts.length;
  await grade(account, [first]);
  const sent = prompts.slice(before).join("\n");
  assert.ok(modelCalls > 0, "grader never called the model");
  assert.ok(sent.includes(ASK), "attacker subject/body never reached the model request");
  assert.ok(sent.includes(sender), "attacker address never reached the model request");
});

await check("one person+credible reading does not store a protecting tier", async () => {
  const account = "no-persist@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-np", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);
  const saved = (await loadPeople(account))[sender];
  assert.equal(
    protecting(saved),
    false,
    `stored ${saved?.tier} by ${saved?.by}`,
  );
});

await check("same reading does not keep a message the model would delete", async () => {
  const account = "same-call@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-del", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "delete_now", sender: "person", credible: true });
  const decisions = await grade(account, [first]);
  const got = decisions.get(first.id);
  assert.equal(got?.action, "delete_now");
  assert.equal(primaryMailAction(got!.action), "trash");
  assert.notEqual(got?.debug.ruleId, "person-protect");
});

await check("later delete-class mail from that address stays deletable", async () => {
  const account = "later-delete@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-later", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);

  const actions: TriageAction[] = [
    "delete_now",
    "unsubscribe",
    "read_and_delete",
    "glance_promo",
  ];
  const later = actions.map((action) =>
    row(`later-${action}`, sender, "Weekly deals", PROMO),
  );
  for (const message of later) {
    const action = actions[later.indexOf(message)]!;
    verdicts.set(message.id, { action, sender: "machine", credible: false });
  }
  const history = historyFor(account, [first, ...later]);
  const decisions = await grade(account, later, undefined, history);
  const mismatches: string[] = [];
  for (const message of later) {
    const want = verdicts.get(message.id)!.action;
    const got = decisions.get(message.id);
    if (got?.action !== want || primaryMailAction(got.action) !== "trash" || got.debug.ruleId === "person-protect") {
      mismatches.push(
        `${want} -> ${got?.action} (${got?.debug.ruleId}, ${got ? primaryMailAction(got.action) : "missing"})`,
      );
    }
  }
  const saved = (await loadPeople(account))[sender];
  if (saved?.tier === "new-credible") {
    mismatches.push(`tier stayed ${saved.tier} by ${saved.by} after a machine judgment`);
  }
  assert.deepEqual(mismatches, []);
});

await check("a cached model delete is not rewritten on the next load", async () => {
  const account = "cached-delete@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-cache", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);
  const promo = row("cache-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  await grade(account, [promo], undefined, historyFor(account, [first, promo]));

  const calls = modelCalls;
  failModel = true;
  try {
    const again = await grade(
      account,
      [promo],
      { geminiEnabled: false },
      historyFor(account, [first, promo]),
    );
    const got = again.get(promo.id);
    assert.equal(modelCalls, calls, "replay graded the message again");
    assert.equal(got?.action, "delete_now", `${got?.action} via ${got?.debug.ruleId}`);
    assert.equal(primaryMailAction(got!.action), "trash");
  } finally {
    failModel = false;
  }
});

await check("rules still delete when the model is down", async () => {
  const account = "rules-down@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-rules", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);

  const promo = row("rules-promo", sender, "Weekly deals", PROMO);
  const history = historyFor(account, [first, promo]);
  const bare = classifyMessage(
    {
      fromEmail: promo.fromEmail,
      fromName: promo.fromName,
      subject: promo.subject,
      snippet: promo.snippet,
    },
    null,
    history,
  );
  assert.ok(DELETEY.has(bare.action), `fixture is not a delete (${bare.action})`);

  failModel = true;
  try {
    const decisions = await grade(account, [promo], undefined, history);
    const got = decisions.get(promo.id);
    assert.equal(got?.action, bare.action, `${got?.action} via ${got?.debug.ruleId}`);
    assert.equal(primaryMailAction(got!.action), "trash");
    assert.notEqual(got?.debug.ruleId, "person-floor");
    assert.notEqual(got?.debug.ruleId, "person-protect");
  } finally {
    failModel = false;
  }
});

await check("a saved delete label is not discarded for an unconfirmed sender", async () => {
  const account = "label-delete@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-label", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);
  await kvSet(`labels-era:${account.toLowerCase()}`, PROMPT_VERSION);
  const promo = row("label-promo", sender, "Weekly deals", PROMO);
  const decisions = await grade(
    account,
    [promo],
    {
      geminiEnabled: false,
      labels: {
        lookup: () => "delete_now",
        persist: async () => {},
      },
    },
    historyFor(account, [first, promo]),
  );
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "delete_now", `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(primaryMailAction(got!.action), "trash");
});

await check("repeated trash by the user is not undone", async () => {
  const account = "learned-trash@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-learned", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);
  const promo = row("learned-promo", sender, "Weekly deals", PROMO);
  const calls = modelCalls;
  const decisions = await grade(
    account,
    [promo],
    {
      actionMemory: {
        [sender]: { archive: 0, trash: 4, lastAt: new Date().toISOString() },
      },
    },
    historyFor(account, [first, promo]),
  );
  const got = decisions.get(promo.id);
  assert.equal(modelCalls, calls, "learned prior still asked the model");
  assert.equal(got?.action, "delete_now", `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(got?.source, "learned");
  assert.equal(primaryMailAction(got!.action), "trash");
});

async function deferCredible(account: string, sender: string, id: string) {
  const first = row(id, sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  let background: Promise<void> = Promise.resolve();
  await grade(account, [first], {
    deferAi: true,
    onDeferred: (run) => {
      background = run();
    },
  });
  await background;
  return first;
}

await check("deferred inbox grading does not store a protecting tier", async () => {
  const account = "deferred-store@example.com";
  const sender = "alex.chen@example.com";
  await deferCredible(account, sender, "ask-defer-store");
  const saved = (await loadPeople(account))[sender];
  assert.equal(protecting(saved), false, `deferred save stored ${saved?.tier} by ${saved?.by}`);
});

await check("deferred inbox grading does not keep later deletable mail", async () => {
  const account = "deferred-later@example.com";
  const sender = "alex.chen@example.com";
  const first = await deferCredible(account, sender, "ask-defer-later");
  const promo = row("defer-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const decisions = await grade(
    account,
    [promo],
    undefined,
    historyFor(account, [first, promo]),
  );
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "delete_now", `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(primaryMailAction(got!.action), "trash");
});

await check("three inbound messages alone do not block deletion", async () => {
  const account = "volume-known@example.com";
  const sender = "alex.chen@example.com";
  const prior = [1, 2, 3].map((n) =>
    row(`vol-${n}`, sender, "Hello", "Just a note from me."),
  );
  const promo = row(
    "vol-promo",
    sender,
    "Album",
    "The album is uploaded.",
  );
  const history = historyFor(account, [...prior, promo]);
  const stat = history.contacts[sender];
  assert.ok((stat?.receivedFrom ?? 0) >= 3, "history did not count inbound mail");
  assert.equal(stat?.sentTo ?? 0, 0);
  const bare = classifyMessage(
    {
      fromEmail: promo.fromEmail,
      fromName: promo.fromName,
      subject: promo.subject,
      snippet: promo.snippet,
    },
    null,
    history,
  );
  assert.ok(DELETEY.has(bare.action), `fixture is not a delete (${bare.action})`);
  const decisions = await grade(account, [promo], { geminiEnabled: false }, history);
  const got = decisions.get(promo.id);
  assert.equal(got?.action, bare.action, `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(primaryMailAction(got!.action), "trash");
  assert.notEqual(got?.debug.ruleId, "person-protect");
});

await check("mail the user already sent still protects that person", async () => {
  const account = "sent-protects@example.com";
  const sender = "alex.chen@example.com";
  const sent = row("sent-1", account, "Re: Harbor", "Sending the draft.");
  sent.peerEmail = sender;
  const promo = row("sent-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const history = historyFor(account, [promo], [sent]);
  assert.ok((history.contacts[sender]?.sentTo ?? 0) > 0);
  const decisions = await grade(account, [promo], undefined, history);
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "read_and_archive", `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(primaryMailAction(got!.action), "archive");
});

await check("a saved contact still protects that person", async () => {
  const account = "contact-protects@example.com";
  const sender = "alex.chen@example.com";
  const promo = row("contact-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const personal: PersonalContext = {
    builtAt: new Date().toISOString(),
    contacts: [sender],
    events: [],
  };
  const decisions = await grade(account, [promo], { personal });
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "read_and_archive");
  assert.equal(primaryMailAction(got!.action), "archive");
});

await check("a meeting still protects that person", async () => {
  const account = "meeting-protects@example.com";
  const sender = "alex.chen@example.com";
  const promo = row("meeting-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const personal: PersonalContext = {
    builtAt: new Date().toISOString(),
    contacts: [],
    events: [
      {
        id: "evt-1",
        subject: "Harbor review",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        attendees: [sender],
      },
    ],
  };
  const decisions = await grade(account, [promo], { personal });
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "read_and_archive");
  assert.equal(primaryMailAction(got!.action), "archive");
});

await check("a user pin still protects that person", async () => {
  const account = "pin-protects@example.com";
  const sender = "alex.chen@example.com";
  await savePeople(account, {
    [sender]: {
      email: sender,
      name: "Alex Chen",
      tier: "inner",
      vip: true,
      reason: "You pinned them as a VIP",
      by: "user",
      judgedAt: new Date().toISOString(),
    },
  });
  const promo = row("pin-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const decisions = await grade(account, [promo]);
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "read_and_archive");
  assert.equal(primaryMailAction(got!.action), "archive");
});

await check("an explicit delete override still deletes", async () => {
  const account = "override-deletes@example.com";
  const sender = "alex.chen@example.com";
  const first = row("ask-over", sender, "Harbor project", ASK);
  verdicts.set(first.id, { action: "respond", sender: "person", credible: true });
  await grade(account, [first]);
  const promo = row("over-promo", sender, "Weekly deals", PROMO);
  const calls = modelCalls;
  const decisions = await grade(
    account,
    [promo],
    undefined,
    historyFor(account, [first, promo]),
    (email) => (email.toLowerCase() === sender ? "delete_now" : null),
  );
  const got = decisions.get(promo.id);
  assert.equal(modelCalls, calls);
  assert.equal(got?.action, "delete_now");
  assert.equal(got?.source, "override");
  assert.equal(primaryMailAction(got!.action), "trash");
});

await check("an auto-collected contact is not a saved contact", async () => {
  const account = "auto-contact@example.com";
  const sender = "alex.chen@example.com";
  const promo = row("auto-promo", sender, "Weekly deals", PROMO);
  verdicts.set(promo.id, { action: "delete_now", sender: "machine", credible: false });
  const personal: PersonalContext = {
    builtAt: new Date().toISOString(),
    contacts: [],
    autoContacts: [sender],
    events: [],
  };
  const decisions = await grade(account, [promo], { personal });
  const got = decisions.get(promo.id);
  assert.equal(got?.action, "delete_now", `${got?.action} via ${got?.debug.ruleId}`);
  assert.equal(primaryMailAction(got!.action), "trash");
});

await rm(dataDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nunconfirmed sender delete bypass: ok");
