/**
 * "Do these next steps": what the confirmation says is what runs. Ticked groups
 * become exact commands, a matter is finished by archiving its mail, a
 * conversation follows the verb the person picked, and nothing outside the
 * selection is touched.
 */
import assert from "node:assert/strict";
import { groupInbox, ageInDays, ageLabel } from "../src/components/v3/inbox-groups.ts";
import { planBulk, planSummary } from "../src/components/v3/bulk-plan.ts";
import { nextStepFor } from "../src/lib/v3/mailbox/next-step.ts";
import type { MailboxRow } from "../src/lib/v3/mailbox/types.ts";

function row(
  id: string,
  over: Partial<MailboxRow> & { matterId?: string | null; ask?: string } = {},
): MailboxRow {
  const matterId = over.matterId ?? null;
  const disposition = over.disposition ?? (matterId ? "matter" : "archive");
  return {
    conversationId: id,
    providerConversationId: `p-${id}`,
    senderDisplayName: `Sender ${id}`,
    subject: `Subject ${id}`,
    timestamp: "2026-08-10T10:00:00.000Z",
    isUnread: false,
    snippet: "",
    attachments: [],
    decisionSummary: "Digest",
    priority: null,
    dueDate: null,
    matterTitle: matterId ? "Roche MSA" : null,
    disposition,
    owner: "nobody",
    deleteRank: 0,
    deleteToken: null,
    category: null,
    vetoReasons: [],
    matterId,
    nextStep: nextStepFor({
      disposition,
      matterId,
      ask: over.ask ?? null,
      summary: "Digest",
      userStep: null,
    }),
    groupKey: matterId ? `m:${matterId}` : `c:${id}`,
    groupAt: over.timestamp ?? "2026-08-10T10:00:00.000Z",
    ...over,
  } as MailboxRow;
}

const rows = [
  row("m1-new", { matterId: "M1", ask: "Send redlines", timestamp: "2026-08-12T10:00:00.000Z", groupAt: "2026-08-01T10:00:00.000Z" }),
  row("m1-old", { matterId: "M1", ask: "Send redlines", timestamp: "2026-08-01T10:00:00.000Z", groupAt: "2026-08-01T10:00:00.000Z" }),
  row("trash-me", { disposition: "delete", timestamp: "2026-08-03T10:00:00.000Z" }),
  row("keep-me", { disposition: "record", timestamp: "2026-08-04T10:00:00.000Z" }),
  row("held", {
    disposition: "undecided",
    vetoReasons: ["personal_greeting"],
    timestamp: "2026-08-05T10:00:00.000Z",
  }),
  row("untouched", { disposition: "archive", timestamp: "2026-08-06T10:00:00.000Z" }),
];

// --- grouping keeps the server's order and folds a matter's mail together ----
const groups = groupInbox(rows);
assert.deepEqual(
  groups.map((group) => group.key),
  ["m:M1", "c:trash-me", "c:keep-me", "c:held", "c:untouched"],
);
assert.equal(groups[0].kind, "matter");
assert.equal(groups[0].rows.length, 2);
assert.equal(groups[0].title, "Roche MSA");
assert.equal(groups[0].oldestAt, "2026-08-01T10:00:00.000Z", "a matter is as old as its oldest email");
assert.equal(groups[0].verb, null, "a matter's step is wording, not a verb");
assert.equal(groups[1].verb, "delete");
assert.equal(groups[2].verb, "record");
assert.equal(groups[3].verb, "archive", "an unplaced conversation is proposed for Archive");

// --- planning ---------------------------------------------------------------
const empty = planBulk(groups, new Set());
assert.equal(empty.commands.length, 0, "nothing ticked, nothing runs");
assert.deepEqual(planSummary(empty), []);

const plan = planBulk(groups, new Set(["m:M1", "c:trash-me", "c:keep-me"]));
assert.deepEqual(plan.commands, [
  { type: "archive", conversationId: "m1-new" },
  { type: "archive", conversationId: "m1-old" },
  { type: "delete", conversationId: "trash-me", byUser: true },
  { type: "correctConversation", conversationId: "keep-me", home: "record" },
  { type: "archive", conversationId: "keep-me" },
]);
assert.equal(plan.emails, 4);
assert.deepEqual(planSummary(plan), [
  "Delete 1 email",
  "Finish 1 matter and archive 2 emails",
  "Keep 1 email for the record",
]);
assert.equal(
  plan.commands.some((command) => "conversationId" in command && command.conversationId === "untouched"),
  false,
  "an unticked conversation is never touched",
);

// --- the person's verb beats Seer's, and Seer's veto is surfaced -------------
const switched = planBulk(groups, new Set(["c:held", "c:trash-me"]), {
  "c:held": "delete",
  "c:trash-me": "archive",
});
assert.deepEqual(switched.commands, [
  { type: "archive", conversationId: "trash-me" },
  { type: "delete", conversationId: "held", byUser: true },
]);
assert.equal(switched.heldBack, 1, "deleting what safety held back is called out");
assert.equal(switched.items[1].heldBack, true);

const plainArchive = planBulk(groups, new Set(["c:held"]));
assert.deepEqual(plainArchive.commands, [{ type: "archive", conversationId: "held" }]);
assert.equal(plainArchive.heldBack, 0);

// --- age ---------------------------------------------------------------------
const now = Date.parse("2026-08-11T10:00:00.000Z");
assert.equal(ageInDays("2026-08-01T10:00:00.000Z", now), 10);
assert.equal(ageInDays("2026-08-20T10:00:00.000Z", now), 0, "never negative");
assert.equal(ageInDays("not a date", now), null);
assert.match(ageLabel("2026-08-01T10:00:00.000Z", now), /10d$/);

console.log("v3-bulk-plan: ok");
