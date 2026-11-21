/**
 * Spec for the unanchored bulk-address prefix bug.
 *
 * A From address whose local part only starts with alert, updates,
 * notifications, newsletter, promo, deals, offers (or the same regex's
 * other mailbox tokens) is graded bulk on the first message. Opening
 * that message, and triage while the model is off or has not answered,
 * then treat urgency wording such as "Action required" as delete now.
 * The reading pane's guide label for that grade is "Don't read — delete".
 *
 * These tests expect the safe behavior. They fail while the prefix
 * match is still live.
 *
 * Whole local parts that are exactly one mailbox token (alert@, updates@,
 * newsletter@, …) are not this bug. A sender the user has already written
 * is not this bug either.
 */
import assert from "node:assert/strict";
import { buildActionGuideDetailed, buildActionGuideQuick } from "../src/lib/inbox/action-guide.ts";
import { classifyMessage } from "../src/lib/inbox/classify.ts";
import { classifyInboxWithAssistant } from "../src/lib/inbox/gemini-triage.ts";
import { buildMailHistory, historySignals } from "../src/lib/inbox/mail-history.ts";
import { compileEmailContext } from "../src/lib/brain/context.ts";
import { stripEmoji } from "../src/lib/inbox/types.ts";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";

const OWNER = "owner@mailbox.test";

/** Local parts that are the whole mailbox token the product may still treat as bulk. */
const EXACT_BULK_LOCAL =
  /^(no-?reply|donotreply|noreply|notifications|alert|updates|mailer-daemon|newsletter|promo|deals|offers)$/i;

/**
 * Addresses an outsider can put in From. None of these local parts is
 * exactly a bulk mailbox token; each only starts with one.
 */
const PREFIX_SENDERS = [
  "alerts@vendor.example",
  "alerter@vendor.example",
  "alert+ops@vendor.example",
  "updates-weekly@vendor.example",
  "notifications-bot@vendor.example",
  "newsletters@vendor.example",
  "promotions@vendor.example",
  "promo-codes@vendor.example",
  "deals-desk@vendor.example",
  "offers-plus@vendor.example",
  "noreply-bot@vendor.example",
  "no-reply-bot@vendor.example",
  "mailer-daemon-bounce@vendor.example",
  // Same delete-now rule, via the marketing-local prefix (not the bulk graph).
  "marketing-team@vendor.example",
  "newsroom@vendor.example",
] as const;

const URGENCY_SUBJECT = "Action required";
const URGENCY_SNIPPET = "Please review this notice from your vendor.";

let failures = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e: unknown) => {
      failures += 1;
      console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
    });
}

function message(fromEmail: string, n: number, subject = URGENCY_SUBJECT, snippet = URGENCY_SNIPPET): MailMessageListItem {
  return {
    id: `m-${n}-${fromEmail}`,
    threadId: `t-${n}-${fromEmail}`,
    fromEmail,
    fromName: "Vendor Notices",
    subject,
    snippet,
    receivedAt: new Date().toISOString(),
    isUnread: true,
  };
}

function firstContactHistory(fromEmail: string) {
  return buildMailHistory(OWNER, [message(fromEmail, 0)], [], []);
}

function assertNotPrefixBulk(fromEmail: string) {
  const local = fromEmail.split("@")[0] ?? "";
  assert.equal(
    EXACT_BULK_LOCAL.test(local),
    false,
    `${fromEmail} is an exact mailbox token and is outside this spec`,
  );
  const signals = historySignals(firstContactHistory(fromEmail), fromEmail);
  assert.equal(
    signals.sentTo,
    0,
    "the user has never mailed this sender",
  );
  assert.equal(signals.keptFrom ?? 0, 0);
  assert.notEqual(
    signals.relationship,
    "bulk",
    `${fromEmail} was marked bulk because its local part only starts with a mailbox token`,
  );
}

function assertNotDeleteNow(
  fromEmail: string,
  graded: { action: string; label?: string; ruleId?: string; task?: string; instruction?: string },
) {
  const shown = stripEmoji(graded.task ?? graded.label ?? "");
  const deleteGrade =
    graded.action === "delete_now" ||
    graded.label === "Don't read — delete" ||
    (graded.ruleId?.includes("urgency-bait-delete") ?? false) ||
    shown === "Don't read — delete" ||
    shown === "Nothing — delete it" ||
    graded.instruction === "Safe to delete without opening.";
  assert.equal(
    deleteGrade,
    false,
    `${fromEmail} was graded don't-read/delete: action=${graded.action} label=${graded.label ?? ""} shown=${JSON.stringify(shown)} instruction=${graded.instruction ?? ""} rule=${graded.ruleId ?? ""}`,
  );
}

console.log("prefix bulk delete grade");

const tests: Promise<void>[] = [];

for (const fromEmail of PREFIX_SENDERS) {
  tests.push(
    check(`relationship: ${fromEmail} is not bulk on first contact`, () => {
      assertNotPrefixBulk(fromEmail);
    }),
  );

  tests.push(
    check(`rules grade: ${fromEmail} + "Action required" is not delete now`, () => {
      const history = firstContactHistory(fromEmail);
      const result = classifyMessage(
        {
          fromEmail,
          fromName: "Vendor Notices",
          subject: URGENCY_SUBJECT,
          snippet: URGENCY_SNIPPET,
        },
        null,
        history,
      );
      assert.notEqual(result.debug.relationship, "bulk");
      assertNotDeleteNow(fromEmail, {
        action: result.action,
        label: undefined,
        ruleId: result.debug.ruleId,
      });
    }),
  );

  tests.push(
    check(`rules grade: urgency only in the preview for ${fromEmail}`, () => {
      const history = firstContactHistory(fromEmail);
      const result = classifyMessage(
        {
          fromEmail,
          fromName: "Vendor Notices",
          subject: "Workspace notice",
          snippet: "Action required before the window closes.",
        },
        null,
        history,
      );
      assertNotDeleteNow(fromEmail, {
        action: result.action,
        ruleId: result.debug.ruleId,
      });
    }),
  );
}

tests.push(
  check("context packet does not call a prefix sender bulk", () => {
    const fromEmail = "alerts@vendor.example";
    const packet = compileEmailContext(
      {
        fromEmail,
        fromName: "Vendor Notices",
        subject: URGENCY_SUBJECT,
        snippet: URGENCY_SNIPPET,
      },
      { history: firstContactHistory(fromEmail) },
    );
    assert.equal(packet.text.includes("bulk/no-reply shape"), false, packet.text);
  }),
);

tests.push(
  check("opening the message (model off) does not say don't read — delete", async () => {
    const fromEmail = "alerts@vendor.example";
    const history = firstContactHistory(fromEmail);
    const item = message(fromEmail, 1);
    const decisions = await classifyInboxWithAssistant(
      OWNER,
      [
        {
          id: item.id,
          fromEmail: item.fromEmail,
          fromName: item.fromName,
          subject: item.subject,
          snippet: item.snippet,
          threadId: item.threadId,
          receivedAt: item.receivedAt,
        },
      ],
      history,
      async () => null,
      classifyMessage,
      { geminiEnabled: false },
    );
    const decision = decisions.get(item.id);
    assert.ok(decision, "reader grade missing");
    assert.equal(decision.source, "rules");
    const guide = await buildActionGuideDetailed(
      decision,
      item.subject,
      item.snippet,
      `${item.subject}\n${item.snippet}`,
      item.fromName,
    );
    assertNotDeleteNow(fromEmail, {
      action: guide.action,
      label: guide.label,
      ruleId: guide.debug?.ruleId,
      task: guide.task,
      instruction: guide.instruction,
    });
    assert.notEqual(guide.debug?.relationship, "bulk");
  }),
);

tests.push(
  check("triage before the model answers does not delete a prefix sender", async () => {
    const rows = PREFIX_SENDERS.map((fromEmail, n) => message(fromEmail, n + 20));
    const history = buildMailHistory(OWNER, rows, [], []);
    // Register the background read the way the inbox routes do, and do not
    // run it. The grade under test is the one returned before that read.
    const decisions = await classifyInboxWithAssistant(
      "triage-owner@mailbox.test",
      rows.map((item) => ({
        id: item.id,
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
        threadId: item.threadId,
        receivedAt: item.receivedAt,
      })),
      history,
      async () => null,
      classifyMessage,
      {
        deferAi: true,
        onDeferred: () => {
          /* model has not answered yet */
        },
      },
    );
    for (const item of rows) {
      const decision = decisions.get(item.id);
      assert.ok(decision, `missing grade for ${item.fromEmail}`);
      const guide = buildActionGuideQuick(decision, item.subject, item.fromName, item.snippet);
      assertNotDeleteNow(item.fromEmail, {
        action: guide.action,
        label: guide.label,
        ruleId: guide.debug?.ruleId,
        task: guide.task,
        instruction: guide.instruction,
      });
    }
  }),
);

tests.push(
  check("a non-prefix sender with the same urgency is not delete now", () => {
    const fromEmail = "security@vendor.example";
    const history = firstContactHistory(fromEmail);
    const signals = historySignals(history, fromEmail);
    assert.notEqual(signals.relationship, "bulk");
    const result = classifyMessage(
      {
        fromEmail,
        fromName: "Vendor Security",
        subject: URGENCY_SUBJECT,
        snippet: URGENCY_SNIPPET,
      },
      null,
      history,
    );
    assert.notEqual(result.action, "delete_now");
  }),
);

tests.push(
  check("someone the user has already mailed is not graded delete now", () => {
    const fromEmail = "alerts@vendor.example";
    const inbound = message(fromEmail, 50);
    const sent: MailMessageListItem = {
      ...message(OWNER, 51),
      fromEmail: OWNER,
      peerEmail: fromEmail,
      threadId: inbound.threadId,
      subject: "Re: earlier",
      snippet: "Thanks",
    };
    const history = buildMailHistory(OWNER, [inbound], [sent], []);
    const signals = historySignals(history, fromEmail);
    assert.equal(signals.relationship, "engaged");
    const result = classifyMessage(
      {
        fromEmail,
        fromName: "Vendor Notices",
        subject: URGENCY_SUBJECT,
        snippet: URGENCY_SNIPPET,
      },
      null,
      history,
    );
    assert.notEqual(result.action, "delete_now");
  }),
);

tests.push(
  check("case and display name do not make Alerts@ a real mailbox token", () => {
    const fromEmail = "Alerts@Vendor.Example";
    assertNotPrefixBulk(fromEmail);
    const result = classifyMessage(
      {
        fromEmail,
        fromName: "Alerts",
        subject: "Expires today",
        snippet: "Your vendor window expires today.",
      },
      null,
      firstContactHistory(fromEmail),
    );
    assertNotDeleteNow(fromEmail, {
      action: result.action,
      ruleId: result.debug.ruleId,
    });
  }),
);

await Promise.all(tests);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
