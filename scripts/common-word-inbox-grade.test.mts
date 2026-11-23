/**
 * Spec for the common-word inbox grade bug.
 *
 * These tests fail while a bounded word from the legacy intel lists
 * (now, calling, send, confirm) or a non-time schedule word (discuss,
 * meeting) is enough to promote a message. They pass once a single
 * common word is not an ask, notice words do not set the actionable
 * flag, and the engaged schedule check stays limited to real time words.
 *
 * The product paths under test are the ones that grade uncached mail
 * with the model off:
 *   POST /api/brief          geminiEnabled: false
 *   GET  /api/messages/[id]  geminiEnabled: false, body sliced to 2000
 *   GET  /api/catchup        geminiEnabled: false
 * and, when no model key is configured, the same rules fallback used by
 * /api/today, /api/mailbox, /api/alltasks, and /api/cron/sync.
 *
 * Run: npx tsx scripts/common-word-inbox-grade.test.mts
 */
import assert from "node:assert/strict";
import { buildActionGuideQuick } from "../src/lib/inbox/action-guide.ts";
import {
  ACTION_META,
  TODAY_SECTION_ORDER,
  classifyMessage,
  type TriageAction,
} from "../src/lib/inbox/classify.ts";
import {
  classifyInboxWithAssistant,
  isGeminiConfigured,
} from "../src/lib/inbox/gemini-triage.ts";
import { buildMailHistory, type MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";

const OWNER = "owner@company.test";
const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

let failures = 0;
let seq = 0;

function check(name: string, fn: () => void | Promise<void>) {
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

function mail(
  partial: Partial<MailMessageListItem> & { id: string; fromEmail: string },
): MailMessageListItem {
  return {
    threadId: partial.threadId ?? partial.id,
    fromName: partial.fromName ?? "Sender",
    subject: partial.subject ?? "Earlier note",
    snippet: partial.snippet ?? "Thanks for the update",
    receivedAt: partial.receivedAt ?? RECENT,
    isUnread: partial.isUnread ?? false,
    ...partial,
  };
}

/** Three prior inbound notes, none of which contain an ask word. */
function knownHistory(fromEmail: string): MailHistory {
  const inbox = [1, 2, 3].map((n) =>
    mail({
      id: `prior-${fromEmail}-${n}`,
      fromEmail,
      subject: "Earlier note",
      snippet: "Thanks for the update",
      receivedAt: new Date(Date.now() - n * 86_400_000).toISOString(),
    }),
  );
  return buildMailHistory(OWNER, inbox, []);
}

/** The mailbox has written to this sender recently, so they are engaged. */
function engagedHistory(fromEmail: string): MailHistory {
  const sent = [
    mail({
      id: `sent-${fromEmail}`,
      fromEmail: OWNER,
      peerEmail: fromEmail,
      subject: "Earlier note",
      snippet: "Thanks for the update",
      receivedAt: RECENT,
    }),
  ];
  return buildMailHistory(OWNER, [], sent);
}

function coldHistory(): MailHistory {
  return buildMailHistory(OWNER, [], []);
}

type Grade = {
  action: TriageAction;
  confidence: string;
  ruleId: string;
  actionable: boolean;
  label: string;
  task: string;
};

/**
 * Same grader call the brief, message, and catch-up routes make for
 * mail that is not already cached: rules fallback, model off.
 * `model` "default" is the today/mailbox/cron call, which leaves the
 * model on but still lands in this fallback when no key is configured.
 */
async function gradeUncached(
  history: MailHistory,
  fromEmail: string,
  subject: string,
  snippet: string,
  model: "off" | "default",
): Promise<Grade> {
  const id = `msg-${seq++}`;
  const decisions = await classifyInboxWithAssistant(
    `grader-${seq}@company.test`,
    [
      {
        id,
        fromEmail,
        fromName: "Pat Example",
        subject,
        snippet,
        receivedAt: new Date().toISOString(),
        threadId: `thread-${id}`,
      },
    ],
    history,
    () => null,
    classifyMessage,
    { geminiEnabled: model === "off" ? false : undefined },
  );
  const result = decisions.get(id);
  assert.ok(result, "uncached mail must receive a grade");
  const guide = buildActionGuideQuick(result, subject, "Pat Example", snippet);
  return {
    action: result.action,
    confidence: result.confidence,
    ruleId: result.debug.ruleId,
    actionable: result.debug.actionable,
    label: guide.label,
    task: guide.task ?? "",
  };
}

function gradeRules(
  history: MailHistory,
  fromEmail: string,
  subject: string,
  snippet: string,
) {
  const result = classifyMessage(
    { fromEmail, fromName: "Pat Example", subject, snippet },
    null,
    history,
  );
  const guide = buildActionGuideQuick(result, subject, "Pat Example", snippet);
  return { result, guide };
}

/** Mirrors the message route: the body, not the preview, is the snippet. */
function messageRouteSnippet(bodyText: string): string {
  return (bodyText || "").slice(0, 2000);
}

const COLD_OTHER = "pat@random-corp.test";
const COLD_PERSONAL = "pat.stranger@gmail.com";
const KNOWN = "pat.repeat@random-corp.test";
const ENGAGED = "pat.friend@random-corp.test";

/**
 * Cold fixtures the fix must keep on skim-and-delete.
 * "Act now" is also urgency-bait phrasing; for a cold sender that rule
 * falls through, and the notice word "now" is what promotes the grade.
 */
const COLD_BAIT: { name: string; subject: string; snippet: string }[] = [
  {
    name: "Act now in the subject",
    subject: "Act now",
    snippet: "See the attached note",
  },
  {
    name: "now in the preview",
    subject: "Weekly note",
    snippet: "Needed now",
  },
  {
    name: "calling in the subject",
    subject: "calling",
    snippet: "See the attached note",
  },
  {
    name: "we send you in the preview",
    subject: "Weekly note",
    snippet: "we send you",
  },
  {
    name: "please confirm in the subject",
    subject: "please confirm",
    snippet: "Hope your week is going well",
  },
];

console.log("common-word inbox grade");

await check("model is off in this run, so the rules fallback is the grade", () => {
  assert.equal(isGeminiConfigured(), false);
});

await check("Needs your call is still the first Today section", () => {
  assert.equal(TODAY_SECTION_ORDER[0], "needs_review");
  assert.equal(ACTION_META.needs_review.label, "Needs your call");
  assert.equal(ACTION_META.read_and_delete.label, "Read and delete");
  assert.equal(ACTION_META.respond.short, "Respond");
});

for (const bait of COLD_BAIT) {
  await check(`cold other sender, ${bait.name}, stays skim-and-delete`, async () => {
    const graded = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      bait.subject,
      bait.snippet,
      "off",
    );
    assert.deepEqual(
      {
        action: graded.action,
        actionable: graded.actionable,
        label: graded.label,
        ruleId: graded.ruleId,
        firstTodaySection: graded.action === TODAY_SECTION_ORDER[0],
      },
      {
        action: "read_and_delete",
        actionable: false,
        label: "Read and delete",
        ruleId: "rules:default-skim-delete",
        firstTodaySection: false,
      },
    );
  });

  await check(
    `cold personal provider, ${bait.name}, stays skim-and-delete`,
    async () => {
      const graded = await gradeUncached(
        coldHistory(),
        COLD_PERSONAL,
        bait.subject,
        bait.snippet,
        "off",
      );
      assert.deepEqual(
        {
          action: graded.action,
          actionable: graded.actionable,
          label: graded.label,
          ruleId: graded.ruleId,
        },
        {
          action: "read_and_delete",
          actionable: false,
          label: "Read and delete",
          ruleId: "rules:personal-default-skim",
        },
      );
    },
  );
}

await check(
  "message route body slice still grades please confirm as skim-and-delete",
  async () => {
    const padding = "lorem ".repeat(300);
    const snippet = messageRouteSnippet(`${padding}please confirm`);
    assert.ok(snippet.includes("please confirm"));
    assert.ok(snippet.length <= 2000);
    const graded = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      "Hello",
      snippet,
      "off",
    );
    assert.equal(graded.action, "read_and_delete");
    assert.equal(graded.actionable, false);
  },
);

await check(
  "today/mailbox/cron rules fallback agrees with the model-off grade",
  async () => {
    const off = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      "Act now",
      "See the attached note",
      "off",
    );
    const fallback = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      "Act now",
      "See the attached note",
      "default",
    );
    assert.equal(fallback.action, "read_and_delete");
    assert.equal(fallback.action, off.action);
    assert.equal(fallback.ruleId, off.ruleId);
  },
);

const KNOWN_BAIT: { name: string; subject: string; snippet: string }[] = [
  { name: "now", subject: "Needed now", snippet: "See the attached note" },
  { name: "calling", subject: "Hello", snippet: "calling" },
  { name: "send", subject: "Weekly note", snippet: "we send you" },
  { name: "confirm", subject: "please confirm", snippet: "Hope your week is going well" },
];

for (const bait of KNOWN_BAIT) {
  await check(
    `three prior messages plus "${bait.name}" is not a reply to send`,
    async () => {
      const graded = await gradeUncached(
        knownHistory(KNOWN),
        KNOWN,
        bait.subject,
        bait.snippet,
        "off",
      );
      const rules = gradeRules(
        knownHistory(KNOWN),
        KNOWN,
        bait.subject,
        bait.snippet,
      );
      assert.equal(rules.result.debug.relationship, "known");
      assert.equal(rules.result.debug.receivedFrom, 3);
      assert.equal(rules.result.debug.sentTo, 0);
      // suggestionFor maps respond to "A short reply closes it".
      assert.deepEqual(
        {
          rulesAction: rules.result.action,
          rulesRule: rules.result.debug.ruleId,
          actionable: rules.result.debug.actionable,
          gradedAction: graded.action,
          gradedRule: graded.ruleId,
          label: graded.label,
          task: graded.task,
        },
        {
          rulesAction: "read_and_delete",
          rulesRule: "known-skim-delete",
          actionable: false,
          gradedAction: "read_and_delete",
          gradedRule: "rules:known-skim-delete",
          label: "Read and delete",
          task: bait.subject.slice(0, 44),
        },
      );
    },
  );
}

const ENGAGED_BAIT: { name: string; subject: string; snippet: string }[] = [
  { name: "now", subject: "Needed now", snippet: "See the attached note" },
  { name: "calling", subject: "calling", snippet: "See the attached note" },
  { name: "send", subject: "Weekly note", snippet: "we send you" },
  { name: "confirm", subject: "please confirm", snippet: "Hope your week is going well" },
];

for (const bait of ENGAGED_BAIT) {
  await check(
    `someone you wrote to, "${bait.name}" is not a high-confidence reply`,
    async () => {
      const history = engagedHistory(ENGAGED);
      const rules = gradeRules(history, ENGAGED, bait.subject, bait.snippet);
      const plain = await gradeUncached(
        history,
        ENGAGED,
        "Hello",
        "Hope your week is going well",
        "off",
      );
      const graded = await gradeUncached(
        history,
        ENGAGED,
        bait.subject,
        bait.snippet,
        "off",
      );
      assert.deepEqual(
        {
          relationship: rules.result.debug.relationship,
          sentTo: rules.result.debug.sentTo,
          stale: rules.result.debug.staleEngagement,
          rulesAction: rules.result.action,
          rulesRule: rules.result.debug.ruleId,
          actionable: rules.result.debug.actionable,
          gradedAction: graded.action,
          gradedConfidence: graded.confidence,
          gradedRule: graded.ruleId,
        },
        {
          relationship: "engaged",
          sentTo: 1,
          stale: false,
          rulesAction: "read_and_archive",
          rulesRule: "engaged-fyi-archive",
          actionable: false,
          gradedAction: plain.action,
          gradedConfidence: plain.confidence,
          gradedRule: plain.ruleId,
        },
      );
    },
  );
}

await check(
  "engaged schedule check ignores discuss and meeting",
  async () => {
    const history = engagedHistory(ENGAGED);
    for (const subject of ["Let's discuss", "Notes from the meeting"]) {
      const rules = gradeRules(history, ENGAGED, subject, "See the attached note");
      const graded = await gradeUncached(
        history,
        ENGAGED,
        subject,
        "See the attached note",
        "off",
      );
      assert.deepEqual(
        {
          subject,
          schedule: rules.result.debug.intel.schedule,
          rulesAction: rules.result.action,
          rulesRule: rules.result.debug.ruleId,
          gradedAsSchedule: graded.action === "act_today",
        },
        {
          subject,
          schedule: 0,
          rulesAction: "read_and_archive",
          rulesRule: "engaged-fyi-archive",
          gradedAsSchedule: false,
        },
      );
      assert.equal(graded.ruleId.includes("schedule"), false, graded.ruleId);
    }
  },
);

await check("engaged real time words still surface today", () => {
  const history = engagedHistory(ENGAGED);
  for (const subject of ["Tomorrow", "See you monday", "Needed asap", "See you today"]) {
    const rules = gradeRules(history, ENGAGED, subject, "See the attached note");
    assert.equal(rules.result.action, "act_today", subject);
    assert.equal(rules.result.debug.ruleId, "engaged-schedule-today", subject);
  }
});

await check("a real ask with an object is still an ask", async () => {
  const questions = [
    "Can you send the signed contract?",
    "Please send the contract.",
    "Could you confirm the booking?",
  ];
  for (const subject of questions) {
    const cold = gradeRules(coldHistory(), COLD_OTHER, subject, "Thanks");
    assert.equal(cold.result.debug.actionable, true, subject);
    assert.equal(cold.result.action, "needs_review", subject);

    const coldGraded = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      subject,
      "Thanks",
      "off",
    );
    assert.equal(coldGraded.action, "needs_review", subject);
    assert.equal(coldGraded.label, "Needs your call", subject);

    const known = gradeRules(knownHistory(KNOWN), KNOWN, subject, "Thanks");
    assert.equal(known.result.action, "respond", subject);

    const engaged = gradeRules(
      engagedHistory(ENGAGED),
      ENGAGED,
      subject,
      "Thanks",
    );
    assert.equal(engaged.result.action, "respond", subject);
    assert.equal(engaged.result.confidence, "HIGH", subject);
    assert.equal(engaged.result.debug.ruleId, "engaged-actionable-respond", subject);
  }
});

await check(
  "the same cold sender without a bait word is already skim-and-delete",
  async () => {
    const graded = await gradeUncached(
      coldHistory(),
      COLD_OTHER,
      "Hello",
      "Hope your week is going well",
      "off",
    );
    assert.equal(graded.action, "read_and_delete");
    assert.equal(graded.ruleId, "rules:default-skim-delete");
  },
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
