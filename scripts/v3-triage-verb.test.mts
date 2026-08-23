/**
 * Gate: triage has three destinations, and every row leaves by one of them.
 *
 * A conversation becomes a matter on Atlas, is archived for the record, or is
 * deleted. The old verbs — File, Answer, Keep — all described mail that was
 * still in the inbox afterwards, which is how a triage screen ended a session
 * with the rows it started with.
 */
import assert from "node:assert/strict";
import {
  dayLabel,
  timeLabel,
  triagePiles,
  verbFor,
  VERB_LABEL,
  VERB_ORDER,
} from "../src/lib/v3/mailbox/triage-verb.ts";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MobileMailboxList } from "../src/components/v3/MobileMailboxList.tsx";
import type { MailboxRow, MailboxView } from "../src/lib/v3/mailbox/types.ts";

const row = (over: Partial<MailboxRow>): MailboxRow => ({
  conversationId: "c",
  providerConversationId: "p",
  senderDisplayName: "Someone",
  subject: "Subject",
  timestamp: "2026-08-17T09:00:00.000Z",
  isUnread: true,
  snippet: "",
  attachments: [],
  decisionSummary: null,
  priority: null,
  dueDate: null,
  matterTitle: null,
  disposition: "matter",
  owner: "nobody",
  deleteRank: 3,
  deleteToken: null,
  category: null,
  vetoReasons: [],
  ...over,
});

// --- which destination --------------------------------------------------------

assert.deepEqual(VERB_ORDER, ["delete", "archive", "review"]);
assert.deepEqual(Object.values(VERB_LABEL), ["Delete", "Archive", "Review"]);

assert.equal(verbFor(row({ disposition: "delete", deleteToken: "t" })), "delete");
assert.equal(verbFor(row({ disposition: "record" })), "archive");

// Everything else is live work, whoever owes the next move. Mail Seer has not
// finished reading is a decision the user still owes, and the board is where
// they owe it — not a fourth pile that means "still in the inbox".
assert.equal(verbFor(row({ disposition: "matter" })), "review");
assert.equal(verbFor(row({ disposition: "undecided" })), "review");
assert.equal(verbFor(row({ disposition: "pending" })), "review");
assert.equal(verbFor(row({ disposition: "matter", owner: "you" })), "review");
assert.equal(verbFor(row({ disposition: "undecided", owner: "them" })), "review");

// A clearance to delete still wins: that pile is the one being emptied.
assert.equal(verbFor(row({ disposition: "delete", owner: "you" })), "delete");

// --- days, as a person reads them ---------------------------------------------

const now = Date.parse("2026-08-17T18:00:00.000Z");
assert.equal(dayLabel("2026-08-17T09:04:00.000Z", now), "Today");
assert.equal(dayLabel("2026-08-16T16:22:00.000Z", now), "Yesterday");
assert.match(dayLabel("2026-08-14T10:00:00.000Z", now), /Aug/, "older mail keeps its date");
assert.equal(dayLabel("not a date", now), "Earlier");

assert.ok(timeLabel("2026-08-17T09:04:00.000Z", now).length > 0);
assert.equal(timeLabel("2026-08-14T09:04:00.000Z", now), "");

// --- the shape of the screen ---------------------------------------------------

{
  const rows = [
    row({ conversationId: "d1", disposition: "delete", deleteToken: "t", timestamp: "2026-08-17T09:00:00.000Z" }),
    row({ conversationId: "d2", disposition: "delete", deleteToken: "t", timestamp: "2026-08-16T09:00:00.000Z" }),
    row({ conversationId: "f1", disposition: "record", timestamp: "2026-08-17T08:00:00.000Z" }),
    row({ conversationId: "a1", disposition: "matter", owner: "you", timestamp: "2026-08-17T07:00:00.000Z" }),
    row({ conversationId: "k1", disposition: "undecided", timestamp: "2026-08-17T06:00:00.000Z" }),
  ];
  const piles = triagePiles(rows, new Set(), now);

  assert.deepEqual(piles.map((p) => p.verb), VERB_ORDER);
  assert.deepEqual(piles.map((p) => p.label), ["Delete", "Archive", "Review"]);
  assert.equal(piles[2].count, 2, "live work of every owner lands on the board");

  // Days sit inside a pile, newest first.
  const del = piles[0];
  assert.equal(del.count, 2);
  assert.deepEqual(del.days.map((d) => d.day), ["Today", "Yesterday"]);
  assert.deepEqual(del.days[0].rows.map((r) => r.conversationId), ["d1"]);

  // A settled row leaves the piles entirely.
  const after = triagePiles(rows, new Set(["d1"]), now);
  assert.equal(after[0].count, 1);

  // An empty pile is not drawn at all.
  assert.deepEqual(
    triagePiles([row({ conversationId: "k", disposition: "matter" })], new Set(), now).map((p) => p.verb),
    ["review"],
  );

  // Settling everything leaves nothing to draw, which is what "clear" means.
  assert.deepEqual(triagePiles(rows, new Set(rows.map((r) => r.conversationId)), now), []);
}

// --- the screen ---------------------------------------------------------------

{
  const rows = [
    row({ conversationId: "d", disposition: "delete", deleteToken: "t", senderDisplayName: "LinkedIn" }),
    row({ conversationId: "f", disposition: "record", senderDisplayName: "DocuSign" }),
    row({ conversationId: "k", disposition: "undecided", senderDisplayName: "Marta" }),
  ];
  const view: MailboxView = {
    accountId: "a",
    folder: "inbox",
    sort: "triage",
    rows,
    total: rows.length,
    needsYou: 1,
    nextCursor: null,
  };
  const html = renderToString(
    createElement(MobileMailboxList, {
      view,
      triage: true,
      onOpen() {},
      onCommands: async () => [],
    } as never),
  ).replace(/<!--[\s\S]*?-->/g, "");

  assert.deepEqual(
    [...html.matchAll(/<h2><span>([^<]*)<\/span>/g)].map((m) => m[1]),
    ["Delete", "Archive", "Review"],
    "uncertain mail is Review, never pre-classified as Atlas",
  );
  for (const gone of ["File", "Answer", "Keep"]) {
    assert.doesNotMatch(html, new RegExp(`<h2><span>${gone}</span>`));
  }

  // Every row can be placed without a gesture, and Atlas is one of the choices.
  const rowActions = [...html.matchAll(/mobile-mail-row-actions[\s\S]*?<\/div>/g)];
  assert.equal(rowActions.length, rows.length, "every triage row can be placed");
  for (const match of rowActions) {
    for (const label of ["Atlas", "Archive", "Delete"]) {
      assert.match(match[0], new RegExp(`>${label}<`));
    }
  }

  // A pile with one obvious outcome can be emptied in one press.
  assert.match(html, />Delete all</);
  assert.match(html, />Archive all</);
}

/**
 * Placing a conversation on Atlas is a correction to Seer's reading, and a
 * correction is law: it is recorded, not merely displayed differently.
 */
const source = await fs.readFile("src/components/v3/MobileMailboxList.tsx", "utf8");
assert.match(source, /type: "triageConversation"/);
assert.match(source, /destination: "matter"/);
assert.match(source, /destination: "archive"/);
assert.match(source, /destination: "delete"/);

console.log("v3-triage-verb: OK");
