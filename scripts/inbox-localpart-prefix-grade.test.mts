/**
 * Spec for the legacy inbox grader's local-part marketing check.
 *
 * A cold sender whose local part merely starts with "news" or "marketing"
 * (newstudent@, marketingliaison@) is not a marketing role. Mail from an
 * educational or government domain that asks something must be graded by
 * the edu/gov rule, and the open-message view must not tell the owner to
 * delete it. These assertions fail while that delete grade is still produced.
 *
 * Shared rules fallback (same classifyMessage the cases below call):
 *   src/app/api/messages/[id]/route.ts  geminiEnabled: false, then the detailed guide
 *   src/app/api/brief/route.ts          geminiEnabled: false, then the quick guide
 *   src/app/api/catchup/route.ts        geminiEnabled: false, then the quick guide
 *   src/app/api/mailbox/route.ts        deferAi provisional grade, same fallback
 *   src/app/api/today/route.ts          same fallback when the model does not grade
 *   src/app/api/alltasks/route.ts       same fallback when the model does not grade
 *   src/app/api/cron/sync/route.ts      same fallback when the model does not grade
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyMessage } from "../src/lib/inbox/classify.ts";
import { buildMailHistory } from "../src/lib/inbox/mail-history.ts";
import { classifyInboxWithAssistant } from "../src/lib/inbox/gemini-triage.ts";
import {
  buildActionGuideDetailed,
  buildActionGuideQuick,
} from "../src/lib/inbox/action-guide.ts";
import { getSenderOverride } from "../src/lib/store/senders.ts";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";

process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "seer-localpart-prefix-"),
);

const OWNER = "owner@example.com";
const NOW = new Date().toISOString();

let failures = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
      );
    });
}

let messageSeq = 0;

function inbound(
  fromEmail: string,
  fromName: string,
  subject: string,
  body: string,
): MailMessageListItem {
  messageSeq += 1;
  return {
    id: `id-${messageSeq}`,
    threadId: `thread-${messageSeq}`,
    fromEmail,
    fromName,
    subject,
    snippet: body,
    receivedAt: NOW,
    isUnread: true,
  };
}

/** Same body selection the open-message route applies before grading. */
function snippetAsOpened(textBody: string, htmlBody = "", preview = ""): string {
  const bodyText =
    textBody || htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return (bodyText || preview).slice(0, 2000);
}

function historyFor(message: MailMessageListItem) {
  return buildMailHistory(OWNER, [message], []);
}

const studentAsk = inbound(
  "newstudent@university.edu",
  "Alex Rivera",
  "Question about my first week",
  snippetAsOpened(
    "Could you confirm which orientation session I should attend?",
  ),
);

const studentUrgent = inbound(
  "newstudent@university.edu",
  "Alex Rivera",
  "Action required: orientation",
  snippetAsOpened(
    "Could you confirm which orientation session I should attend?",
  ),
);

const studentFyi = inbound(
  "newstudent@university.edu",
  "Alex Rivera",
  "Library catalog",
  snippetAsOpened("The library catalog was updated this term."),
);

const agencyAsk = inbound(
  "marketingliaison@transport.gov",
  "Jordan Lee",
  "Permit question",
  snippetAsOpened("Could you send the form I need to file?"),
);

const studentAskDeferred = inbound(
  "newstudent@university.edu",
  "Alex Rivera",
  "Question about my first week",
  snippetAsOpened(
    "Could you confirm which orientation session I should attend?",
  ),
);

const realNewsletter = inbound(
  "newsletter@shop.example",
  "Shop",
  "Weekend sale",
  snippetAsOpened("50% off and free shipping if you shop now."),
);

function grade(message: MailMessageListItem) {
  return classifyMessage(
    {
      fromEmail: message.fromEmail,
      fromName: message.fromName,
      subject: message.subject,
      snippet: message.snippet,
    },
    null,
    historyFor(message),
  );
}

async function openGrade(
  message: MailMessageListItem,
  extras?: { deferAi?: boolean },
) {
  let deferred: (() => Promise<void>) | undefined;
  const decisions = await classifyInboxWithAssistant(
    OWNER,
    [
      {
        id: message.id,
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: message.snippet,
        threadId: message.threadId,
        receivedAt: message.receivedAt,
      },
    ],
    historyFor(message),
    (email) => getSenderOverride(email),
    classifyMessage,
    extras?.deferAi
      ? {
          geminiEnabled: true,
          deferAi: true,
          onDeferred: (run) => {
            deferred = run;
          },
        }
      : { geminiEnabled: false },
  );
  const classification = decisions.get(message.id);
  assert.ok(classification, "open path returned no grade");
  const detailed = await buildActionGuideDetailed(
    classification,
    message.subject,
    message.snippet,
    message.snippet,
    message.fromName,
  );
  const quick = buildActionGuideQuick(
    classification,
    message.subject,
    message.fromName,
    message.snippet,
  );
  return { classification, detailed, quick, deferred };
}

function assertNotDeleteCopy(guide: {
  action: string;
  label: string;
  instruction: string;
  task?: string;
  harm?: string;
}) {
  assert.notEqual(guide.action, "delete_now");
  assert.notEqual(guide.action, "unsubscribe");
  assert.doesNotMatch(guide.label, /don'?t read|delete/i);
  assert.doesNotMatch(guide.instruction, /safe to delete/i);
  assert.doesNotMatch(guide.task ?? "", /nothing — delete|safe to delete/i);
  assert.doesNotMatch(guide.harm ?? "", /none\. if it truly mattered/i);
}

console.log("inbox local-part prefix grade");

await check("a first note from newstudent@ is cold, not bulk", () => {
  const signals = grade(studentAsk).debug;
  assert.equal(signals.relationship, "cold");
  assert.equal(signals.sentTo, 0);
  assert.equal(signals.receivedFrom, 1);
  assert.equal(signals.actionable, true);
});

await check("a first note from marketingliaison@ is cold, not bulk", () => {
  const signals = grade(agencyAsk).debug;
  assert.equal(signals.relationship, "cold");
  assert.equal(signals.receivedFrom, 1);
  assert.equal(signals.actionable, true);
});

await check(
  "newstudent@university.edu with an ask is an edu reply, not a marketing delete",
  () => {
    const result = grade(studentAsk);
    assert.equal(result.action, "respond");
    assert.equal(result.debug.ruleId, "edu-gov-respond");
    assert.equal(result.debug.relationship, "cold");
  },
);

await check(
  "marketingliaison@transport.gov with an ask is a gov reply, not a marketing delete",
  () => {
    const result = grade(agencyAsk);
    assert.equal(result.action, "respond");
    assert.equal(result.debug.ruleId, "edu-gov-respond");
  },
);

await check(
  "newstudent@university.edu with no ask is kept, not deleted",
  () => {
    const result = grade(studentFyi);
    assert.equal(result.debug.actionable, false);
    assert.equal(result.action, "read_and_archive");
    assert.equal(result.debug.ruleId, "edu-gov-archive");
  },
);

await check(
  "urgency bait from newstudent@university.edu still follows the edu rule",
  () => {
    const result = grade(studentUrgent);
    assert.equal(result.action, "respond");
    assert.equal(result.debug.ruleId, "edu-gov-respond");
    assert.notEqual(result.debug.ruleId, "urgency-bait-delete");
    assert.notEqual(result.debug.ruleId, "marketing-cold-delete");
  },
);

await check(
  "opening the student ask grades with rules and does not say to delete",
  async () => {
    const { classification, detailed, quick } = await openGrade(studentAsk);
    assert.equal(classification.source, "rules");
    assert.equal(classification.action, "respond");
    assert.equal(classification.debug.ruleId, "rules:edu-gov-respond");
    assert.equal(detailed.action, "respond");
    assert.equal(detailed.label, "Respond to this");
    assertNotDeleteCopy(detailed);
    assert.equal(quick.action, "respond");
    assertNotDeleteCopy(quick);
    // ReaderGuideBar renders task, then label.
    assert.notEqual(detailed.task, "Nothing — delete it");
    assert.notEqual(quick.task, "Nothing — delete it");
  },
);

await check(
  "opening the gov ask grades with rules and does not say to delete",
  async () => {
    const { classification, detailed, quick } = await openGrade(agencyAsk);
    assert.equal(classification.source, "rules");
    assert.equal(classification.action, "respond");
    assert.equal(classification.debug.ruleId, "rules:edu-gov-respond");
    assertNotDeleteCopy(detailed);
    assertNotDeleteCopy(quick);
  },
);

await check(
  "opening an urgency-bait student note still follows the edu rule",
  async () => {
    const { classification, detailed } = await openGrade(studentUrgent);
    assert.equal(classification.source, "rules");
    assert.equal(classification.action, "respond");
    assert.equal(classification.debug.ruleId, "rules:edu-gov-respond");
    assertNotDeleteCopy(detailed);
  },
);

await check(
  "opening a non-ask student note keeps it instead of deleting it",
  async () => {
    const { classification, detailed, quick } = await openGrade(studentFyi);
    assert.equal(classification.source, "rules");
    assert.equal(classification.action, "read_and_archive");
    assert.equal(classification.debug.ruleId, "rules:edu-gov-archive");
    assert.equal(detailed.action, "read_and_archive");
    assert.equal(detailed.label, "Read and archive");
    assertNotDeleteCopy(detailed);
    assertNotDeleteCopy(quick);
  },
);

await check(
  "the mailbox provisional grade (model deferred) does not delete the student ask",
  async () => {
    process.env.GEMINI_API_KEY = "placeholder";
    try {
      const { classification, quick, deferred } = await openGrade(
        studentAskDeferred,
        { deferAi: true },
      );
      assert.equal(typeof deferred, "function");
      assert.equal(classification.action, "respond");
      assert.equal(classification.debug.ruleId, "rules:edu-gov-respond");
      assertNotDeleteCopy(quick);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  },
);

await check(
  "a real newsletter local part stays on the bulk keep rule",
  () => {
    const result = grade(realNewsletter);
    assert.equal(result.debug.relationship, "bulk");
    assert.equal(result.action, "read_and_archive");
    assert.equal(result.debug.ruleId, "bulk-keep-until-read");
  },
);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
