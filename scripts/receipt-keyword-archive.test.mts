/**
 * Unknown senders must not be filed as receipt records just because the
 * subject or preview contains receipt, payment, billing, statement,
 * invoice, or "your order".
 *
 * These tests fail while that rules grade is what the reader, Today, and
 * the mailbox show. They pass once an unknown sender stays in review
 * unless the sender is a known biller, there is a prior charge from
 * them, or a model read has finished.
 *
 * Left untested: the autopay-record-archive rule (autopay + bill-ready
 * wording, classify.ts). It can also archive without a known sender, but
 * it does not use the receipt-keyword list this finding describes.
 * /api/brief and /api/catchup call the same rules-only grader as the
 * reader and are covered by the geminiEnabled:false case. /api/alltasks
 * calls the same grader with the model left on, covered by the
 * model-unavailable case.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "receipt-keyword-archive-"),
);
for (const key of [
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
const { buildMailHistory } = await import("../src/lib/inbox/mail-history.ts");
const { classifyInboxWithAssistant, isGeminiConfigured } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");

import type { TriageAction } from "../src/lib/inbox/classify.ts";
import type { MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { GeminiTriageItem } from "../src/lib/inbox/gemini-triage.ts";
import type { MailAction } from "../src/lib/inbox/types.ts";

const OWNER = "owner@mailbox.test";
const STRANGER = "pat@random-mail.test";
const NOW = "2026-11-20T17:00:00.000Z";

const RECEIPT_SUBJECTS = [
  "Your receipt",
  "Payment",
  "Billing notice",
  "Your statement",
  "Your order",
  "Invoice",
] as const;

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

function row(
  id: string,
  fromEmail: string,
  subject: string,
  snippet: string,
): GeminiTriageItem & {
  fromName: string;
  threadId: string;
  receivedAt: string;
  isUnread: boolean;
} {
  return {
    id,
    threadId: `thread-${id}`,
    fromEmail,
    fromName: "Pat",
    subject,
    snippet,
    receivedAt: NOW,
    isUnread: true,
  };
}

function historyFor(items: { fromEmail: string; receivedAt: string; threadId: string; id: string; fromName: string; subject: string; snippet: string; isUnread: boolean }[]): MailHistory {
  return buildMailHistory(
    OWNER,
    items.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      subject: m.subject,
      snippet: m.snippet,
      receivedAt: m.receivedAt,
      isUnread: m.isUnread,
    })),
    [],
    [],
  );
}

/**
 * CardStack's one-tap suggestion (src/components/inbox/CardStack.tsx).
 * needs_review and act_today open the message. Every other action
 * commits primaryMailAction, which is archive for read_and_archive.
 */
function suggestedDisposition(
  action: TriageAction,
): "reply" | "open" | MailAction {
  if (action === "respond") return "reply";
  if (action === "act_today" || action === "needs_review") return "open";
  return primaryMailAction(action);
}

/** Same grouping as src/app/api/today/route.ts after classification. */
function todaySections(
  items: ReturnType<typeof row>[],
  decisions: Map<string, { action: TriageAction; debug: { ruleId: string } }>,
) {
  const classified = items.map((m) => {
    const result = decisions.get(m.id);
    assert.ok(result, `missing decision for ${m.id}`);
    const guide = buildActionGuideQuick(result, m.subject, m.fromName, m.snippet);
    return { ...m, guide };
  });
  const needsReview = classified.filter((e) => e.guide.action === "needs_review");
  const processed = classified.filter(
    (e) =>
      e.guide.action !== "needs_review" &&
      e.guide.debug?.ruleId !== "thread-sibling",
  );
  const byAction = new Map<TriageAction, typeof processed>();
  for (const e of processed) {
    const list = byAction.get(e.guide.action) ?? [];
    list.push(e);
    byAction.set(e.guide.action, list);
  }
  const sections = TODAY_SECTION_ORDER.filter(
    (action) => action !== "needs_review" && (byAction.get(action)?.length ?? 0) > 0,
  ).map((action) => ({
    action,
    label: ACTION_META[action].label,
    bulkLabel: ACTION_META[action].bulkLabel,
    primary: primaryMailAction(action),
    items: byAction.get(action) ?? [],
  }));
  return { classified, needsReview, sections };
}

function assertInReview(
  action: TriageAction,
  ruleId: string,
  where: string,
) {
  assert.equal(
    action,
    "needs_review",
    `${where}: unknown sender was graded ${action} (${ruleId})`,
  );
  assert.equal(
    ruleId.includes("finance-record-archive"),
    false,
    `${where}: still filed by finance-record-archive`,
  );
  assert.equal(
    suggestedDisposition(action),
    "open",
    `${where}: one-tap suggestion would ${suggestedDisposition(action)}`,
  );
}

console.log("receipt keyword archive");
assert.equal(
  isGeminiConfigured(),
  false,
  "this test must run with the model unconfigured",
);

await check("rules grader: receipt words from a stranger stay in review", () => {
  const history = historyFor([
    row("seed", STRANGER, "Hello", "hello"),
  ]);
  for (const subject of RECEIPT_SUBJECTS) {
    const graded = classifyMessage(
      {
        fromEmail: STRANGER,
        fromName: "Pat",
        subject,
        snippet: "Please see the note.",
      },
      null,
      history,
    );
    assert.equal(graded.debug.relationship, "cold");
    assertInReview(graded.action, graded.debug.ruleId, `subject ${subject}`);
  }
  const preview = classifyMessage(
    {
      fromEmail: STRANGER,
      fromName: "Pat",
      subject: "Hello",
      snippet: "Here is your receipt for the charge.",
    },
    null,
    history,
  );
  assertInReview(preview.action, preview.debug.ruleId, "preview receipt");
});

await check("rules grader: the same stranger without those words is not a finance record", () => {
  const history = historyFor([row("seed", STRANGER, "Hello", "hello")]);
  const graded = classifyMessage(
    {
      fromEmail: STRANGER,
      fromName: "Pat",
      subject: "Hello",
      snippet: "Just a note.",
    },
    null,
    history,
  );
  assert.equal(graded.debug.ruleId.includes("finance-record-archive"), false);
  assert.notEqual(graded.action, "read_and_archive");
});

await check("rules grader: a known biller statement can still be archived", () => {
  const from = "statements@chase.com";
  const item = row("chase", from, "Your statement", "Monthly statement");
  const graded = classifyMessage(
    {
      fromEmail: from,
      fromName: "Chase",
      subject: item.subject,
      snippet: item.snippet,
    },
    null,
    historyFor([item]),
  );
  assert.equal(graded.action, "read_and_archive");
});

await check("rules grader: payment failed from a stranger still needs action today", () => {
  const graded = classifyMessage(
    {
      fromEmail: STRANGER,
      fromName: "Pat",
      subject: "Payment failed",
      snippet: "Your card was declined.",
    },
    null,
    historyFor([row("risk", STRANGER, "Payment failed", "Your card was declined.")]),
  );
  assert.equal(graded.action, "act_today");
});

await check("rules grader: product-notification receipt words are not an archive record", () => {
  const from = "notifications@github.com";
  const graded = classifyMessage(
    {
      fromEmail: from,
      fromName: "GitHub",
      subject: "Your receipt",
      snippet: "Thanks for your order.",
    },
    null,
    historyFor([row("gh", from, "Your receipt", "Thanks for your order.")]),
  );
  assertInReview(graded.action, graded.debug.ruleId, "github receipt");
});

await check("reader path: opening the message grades with rules only and stays in review", async () => {
  const body = "Hello. Attached is your receipt for a payment of $40.";
  const item = row("open-1", STRANGER, "Hello", body);
  const decisions = await classifyInboxWithAssistant(
    OWNER,
    [item],
    historyFor([item]),
    () => null,
    classifyMessage,
    { geminiEnabled: false },
  );
  const decision = decisions.get(item.id);
  assert.ok(decision);
  assert.equal(decision.source, "rules");
  assert.equal(decision.pending, undefined);
  assertInReview(decision.action, decision.debug.ruleId, "reader");
  const guide = buildActionGuideQuick(
    decision,
    item.subject,
    item.fromName,
    item.snippet,
  );
  assert.equal(guide.action, "needs_review");
  assert.doesNotMatch(guide.instruction, /archive/i);
  assert.equal(guide.label, ACTION_META.needs_review.label);
});

await check("model unavailable: the mailbox keeps the review grade, not a receipt archive", async () => {
  const items = RECEIPT_SUBJECTS.map((subject, i) =>
    row(`keep-${i}`, STRANGER, subject, "See the attached note."),
  );
  items.push(
    row("keep-preview", STRANGER, "Hello", "Billing update and your receipt."),
  );
  const history = historyFor(items);
  const grade = () =>
    classifyInboxWithAssistant(
      `${OWNER}`,
      items,
      history,
      () => null,
      classifyMessage,
    );
  const first = await grade();
  const second = await grade();
  for (const item of items) {
    const a = first.get(item.id);
    const b = second.get(item.id);
    assert.ok(a && b);
    assert.equal(a.source, "rules");
    assert.equal(b.source, "rules");
    assert.notEqual(a.pending, true);
    assert.notEqual(b.pending, true);
    assertInReview(a.action, a.debug.ruleId, `first load ${item.subject}`);
    assertInReview(b.action, b.debug.ruleId, `second load ${item.subject}`);
  }
});

await check("today and mailbox: rules grade is shown before a deferred model read", async () => {
  const items = [
    row("defer-receipt", STRANGER, "Your receipt", "Nothing else."),
    row("defer-order", "alex@gmail.com", "Your order", "A stranger wrote this."),
    row("defer-pay", "billing@not-a-bank.test", "Payment", "Please review."),
    row("defer-known", "statements@chase.com", "Your statement", "Monthly statement."),
  ];
  let deferred = false;
  process.env.VERCEL = "1";
  try {
    assert.equal(isGeminiConfigured(), true);
    const decisions = await classifyInboxWithAssistant(
      "defer@mailbox.test",
      items,
      historyFor(items),
      () => null,
      classifyMessage,
      {
        deferAi: true,
        onDeferred: () => {
          deferred = true;
        },
      },
    );
    assert.equal(deferred, true);
    for (const id of ["defer-receipt", "defer-order", "defer-pay"]) {
      const decision = decisions.get(id);
      assert.ok(decision);
      assert.equal(decision.source, "rules");
      assertInReview(decision.action, decision.debug.ruleId, id);
    }
    const known = decisions.get("defer-known");
    assert.ok(known);
    assert.equal(known.action, "read_and_archive");

    const { needsReview, sections } = todaySections(items, decisions);
    const reviewIds = new Set(needsReview.map((e) => e.id));
    for (const id of ["defer-receipt", "defer-order", "defer-pay"]) {
      assert.equal(reviewIds.has(id), true, `${id} missing from review`);
    }
    const archive = sections.find((s) => s.action === "read_and_archive");
    assert.ok(archive, "known biller should still form an archive section");
    assert.equal(archive.bulkLabel, "Archive all");
    assert.equal(archive.primary, "archive");
    assert.deepEqual(
      archive.items.map((i) => i.id),
      ["defer-known"],
    );
    for (const section of sections) {
      if (section.action !== "read_and_archive") continue;
      for (const item of section.items) {
        assert.notEqual(item.fromEmail, STRANGER);
        assert.notEqual(item.fromEmail, "alex@gmail.com");
        assert.notEqual(item.fromEmail, "billing@not-a-bank.test");
      }
    }
  } finally {
    delete process.env.VERCEL;
  }
});

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
