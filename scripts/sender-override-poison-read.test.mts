/**
 * Read-side of the shared sender-override crash.
 *
 * A value that is already in the deployment-wide `sender-overrides` document
 * must not take down inbox classification. These assertions fail while an
 * unknown stored action is applied and `ACTION_META[action].label` throws.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/sender-override-poison-read.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-override-read-"));
process.env.SEER_DATA_DIR = dataDir;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_TOKEN;
delete process.env.OPENAI_API_KEY;

const POISON_SENDER = "digest@newsletters.example";
const POISON_ACTION = "not_a_triage_action";
const TRIAGE_ACTIONS = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
] as const;

const kv = await import("../src/lib/store/kv.ts");
// Plant the poison the same way a previous write left it: one JSON document
// under the shared key, with no per-account scope. This happens before the
// sender store is imported so its memo cannot hide the document.
await kv.kvSet("sender-overrides", {
  [POISON_SENDER]: POISON_ACTION,
});

const senders = await import("../src/lib/store/senders.ts");
const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideQuick, buildActionGuideDetailed } = await import(
  "../src/lib/inbox/action-guide.ts"
);

const message = {
  id: "msg-poison-1",
  threadId: "thread-poison-1",
  fromEmail: POISON_SENDER,
  fromName: "Digest",
  subject: "Weekly notes",
  snippet: "Here is the digest.",
  receivedAt: "2026-11-01T15:00:00.000Z",
};

function assertKnown(action: string, where: string) {
  assert.ok(
    (TRIAGE_ACTIONS as readonly string[]).includes(action),
    `${where} returned ${JSON.stringify(action)}, which is not a triage action`,
  );
}

/**
 * The same calls /api/today, /api/mailbox, /api/brief, /api/alltasks,
 * /api/catchup, /api/messages/[id], and /api/cron/sync make after they
 * have a message list: look up the override, classify, then (except
 * catchup and cron) build the action guide. Catchup and cron still die
 * when classifyInboxWithAssistant throws.
 */
async function gradeLikeLegacyInbox(accountEmail: string) {
  const decisions = await classifyInboxWithAssistant(
    accountEmail,
    [message],
    null,
    (email) => senders.getSenderOverride(email),
    classifyMessage,
    { geminiEnabled: false },
  );
  const result = decisions.get(message.id);
  assert.ok(result, `${accountEmail} received no classification`);
  const quick = buildActionGuideQuick(
    result,
    message.subject,
    message.fromName,
    message.snippet,
  );
  const detailed = await buildActionGuideDetailed(
    result,
    message.subject,
    message.snippet,
    message.snippet,
    message.fromName,
  );
  assertKnown(quick.action, `${accountEmail} quick guide`);
  assertKnown(detailed.action, `${accountEmail} detailed guide`);
  assert.equal(typeof quick.label, "string");
  assert.ok(quick.label.length > 0, "guide label was empty");
  assert.notEqual(
    quick.source,
    "override",
    `${accountEmail} applied an unknown stored action as a taught override`,
  );

  // /api/messages/[id] uses this when the assistant map has no row.
  const stored = await senders.getSenderOverride(message.fromEmail);
  const fallback = classifyMessage(
    {
      fromEmail: message.fromEmail,
      fromName: message.fromName,
      subject: message.subject,
      snippet: message.snippet,
    },
    stored,
    null,
  );
  const fallbackGuide = await buildActionGuideDetailed(
    { ...fallback, source: "rules" },
    message.subject,
    message.snippet,
    message.snippet,
    message.fromName,
  );
  assertKnown(fallbackGuide.action, `${accountEmail} message fallback`);
  assert.notEqual(fallback.action, POISON_ACTION);
}

try {
  await gradeLikeLegacyInbox("victim@rditrials.com");
  await gradeLikeLegacyInbox("attacker@rditrials.com");
  console.log("sender-override-poison-read: ok");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
