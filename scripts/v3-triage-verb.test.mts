/**
 * Gate: triage is four verbs, and the days belong to the mail.
 *
 * The piles are named after what the user is about to do, not after what Seer
 * concluded. Anything not deleted and not filed is live work, so Keep is the
 * door onto the whiteboard — triage is the mouth of Atlas.
 */
import assert from "node:assert/strict";
import {
  dayLabel,
  likelyDisposition,
  timeLabel,
  triagePiles,
  verbFor,
  VERB_ORDER,
} from "../src/lib/v3/mailbox/triage-verb.ts";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { dismissesLocally, TriageList } from "../src/components/v3/TriageList.tsx";
import type { MailboxRow } from "../src/lib/v3/mailbox/types.ts";

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

// --- which pile ---------------------------------------------------------------

assert.equal(verbFor(row({ disposition: "delete", deleteToken: "t" })), "delete");
assert.equal(verbFor(row({ disposition: "record" })), "file");
assert.equal(verbFor(row({ disposition: "matter" })), "keep");
assert.equal(verbFor(row({ disposition: "undecided" })), "keep");
assert.equal(verbFor(row({ disposition: "pending" })), "keep");

// Owing a reply outranks everything but a likely delete: burying a reply
// you owe under "keep" is how it goes unsent for a fortnight.
assert.equal(verbFor(row({ disposition: "matter", owner: "you" })), "answer");
assert.equal(verbFor(row({ disposition: "record", owner: "you" })), "answer");
assert.equal(verbFor(row({ disposition: "undecided", owner: "you" })), "answer");

// A clearance to delete still wins, because that pile is the one being emptied.
assert.equal(verbFor(row({ disposition: "delete", owner: "you" })), "delete");

// Work with someone else is not yours to answer.
assert.equal(verbFor(row({ disposition: "matter", owner: "them" })), "keep");
assert.equal(verbFor(row({ disposition: "matter", owner: "team" })), "keep");

// Proposed home drives likely action when durable home was vetoed to undecided.
{
  const vetoedDelete = row({
    disposition: "undecided",
    proposedDisposition: "delete",
    owner: "nobody",
    deleteToken: null,
    vetoReasons: ["live_matter"],
  });
  assert.equal(verbFor(vetoedDelete), "delete");
  assert.equal(likelyDisposition(vetoedDelete), "delete");
  // Grouping must not mint safety state or rewrite the durable decision.
  assert.equal(vetoedDelete.disposition, "undecided");
  assert.equal(vetoedDelete.deleteToken, null);
  assert.deepEqual(vetoedDelete.vetoReasons, ["live_matter"]);
}

assert.equal(
  verbFor(row({ disposition: "undecided", proposedDisposition: "record" })),
  "file",
);
assert.equal(
  verbFor(
    row({
      disposition: "undecided",
      proposedDisposition: "delete",
      owner: "you",
    }),
  ),
  "delete",
  "likely delete still outranks owing a reply",
);
assert.equal(
  verbFor(
    row({
      disposition: "undecided",
      proposedDisposition: "record",
      owner: "you",
    }),
  ),
  "answer",
  "owner you still makes non-delete mail Answer",
);

// --- days, as a person reads them ---------------------------------------------

const now = Date.parse("2026-08-17T18:00:00.000Z");
assert.equal(dayLabel("2026-08-17T09:04:00.000Z", now), "Today");
assert.equal(dayLabel("2026-08-16T16:22:00.000Z", now), "Yesterday");
assert.match(dayLabel("2026-08-14T10:00:00.000Z", now), /Aug/, "older mail keeps its date");
assert.equal(dayLabel("not a date", now), "Earlier");

// A clock time is only meaningful for today.
assert.ok(timeLabel("2026-08-17T09:04:00.000Z", now).length > 0);
assert.equal(timeLabel("2026-08-14T09:04:00.000Z", now), "");

// --- the shape of the screen ---------------------------------------------------

{
  const rows = [
    row({ conversationId: "d1", disposition: "delete", deleteToken: "t", timestamp: "2026-08-17T09:00:00.000Z" }),
    row({ conversationId: "d2", disposition: "delete", deleteToken: "t", timestamp: "2026-08-16T09:00:00.000Z" }),
    row({ conversationId: "f1", disposition: "record", timestamp: "2026-08-17T08:00:00.000Z" }),
    row({ conversationId: "a1", disposition: "matter", owner: "you", timestamp: "2026-08-17T07:00:00.000Z" }),
    row({ conversationId: "k1", disposition: "matter", timestamp: "2026-08-17T06:00:00.000Z" }),
    row({
      conversationId: "vd",
      disposition: "undecided",
      proposedDisposition: "delete",
      vetoReasons: ["live_matter"],
      timestamp: "2026-08-17T05:00:00.000Z",
    }),
  ];
  const piles = triagePiles(rows, new Set(), now);

  assert.deepEqual(
    piles.map((p) => p.verb),
    VERB_ORDER,
    "the piles come in the order the work is done",
  );
  assert.deepEqual(
    piles.map((p) => p.label),
    ["Delete", "Archive", "Answer", "Atlas"],
  );

  // Days sit inside a pile, newest first. Vetoed-proposed deletes join Delete.
  const del = piles[0];
  assert.equal(del.count, 3);
  assert.deepEqual(del.days.map((d) => d.day), ["Today", "Yesterday"]);
  assert.deepEqual(
    del.days[0].rows.map((r) => r.conversationId),
    ["d1", "vd"],
  );

  // A dismissed row leaves the piles entirely.
  const after = triagePiles(rows, new Set(["d1"]), now);
  assert.equal(after[0].count, 2);

  // An empty pile is not drawn at all.
  const onlyKeep = triagePiles([row({ conversationId: "k", disposition: "matter" })], new Set(), now);
  assert.deepEqual(onlyKeep.map((p) => p.verb), ["keep"]);

  // Dismissing everything leaves nothing to draw, which is what "clear" means.
  assert.deepEqual(triagePiles(rows, new Set(rows.map((r) => r.conversationId)), now), []);
}

// --- the screen ---------------------------------------------------------------

{
  const html = renderToString(
    createElement(TriageList, {
      rows: [
        row({ conversationId: "d", disposition: "delete", deleteToken: "t", senderDisplayName: "LinkedIn" }),
        row({ conversationId: "d2", disposition: "delete", deleteToken: "t", senderDisplayName: "Eventbrite" }),
        row({ conversationId: "f", disposition: "record", senderDisplayName: "DocuSign" }),
        row({ conversationId: "a", disposition: "matter", owner: "you", senderDisplayName: "Vincent" }),
        row({ conversationId: "k", disposition: "matter", senderDisplayName: "Marta" }),
      ],
      onCommands: async () => {},
      onOpen() {},
    } as never),
  ).replace(/<!--[\s\S]*?-->/g, "");

  assert.deepEqual(
    [...html.matchAll(/class="tri-g"><span>([^<]*)<em/g)].map((m) => m[1]),
    ["Delete", "Archive", "Answer", "Atlas"],
    "categories are ordered by likelihood of action",
  );
  assert.match(html, /class="tri-day tabular"/, "the mail keeps its own days inside");

  // Both destinations are named on the track before the pull commits.
  assert.match(html, />ATLAS</);
  assert.match(html, />ARCHIVE</);

  // A row that owes a reply says so rather than leaving it to be inferred.
  assert.match(html, /You owe a reply/);

  // No local Deleted/Archived undo strip — mailbox/outbox notice owns that.
  assert.doesNotMatch(html, /tri-settled/);

  // A pile can be taken whole, and says how many that is. Clearing a pile is
  // the job; ticking sixty newsletters one at a time is not.
  assert.deepEqual(
    [...html.matchAll(/class="tri-pile-select"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ["Select all 2", "Select all 1", "Select all 1", "Select all 1"],
    "every pile offers its own select-all, counted",
  );
}

/**
 * Keeping is the door onto the whiteboard. Anything not deleted and not filed
 * is live work, so Keep records a correction to matter — and a correction is
 * law, so it is not second-guessed by the safety layer.
 */
const source = await fs.readFile("src/components/v3/TriageList.tsx", "utf8");
assert.match(source, /type: "correctConversation"/, "Keep corrects the decision");
assert.match(source, /home: "matter"/, "Keep puts the conversation on Atlas");
assert.match(source, /byUser: true/, "deleting from triage is the user's own call");
assert.match(source, /type: "archive"/, "filing archives");
assert.match(source, /reduceSelection/, "triage shares tested range-selection semantics");
assert.match(source, /event\.metaKey \|\| event\.ctrlKey/, "multi-click selects rows");
assert.match(source, /event\.key\.toLowerCase\(\) === "j"/, "J/K keyboard navigation");
assert.match(source, /onWheel/, "desktop trackpad gestures use the swipe rail");
assert.match(source, /bulkAct\("delete"\)/, "selected rows can be deleted together");
assert.match(source, /kind: "group", ids, checked/, "a pile is selected as a pile");
assert.match(
  source,
  /selectPile\(pileIds, !wholePile\)/,
  "the pile control takes the whole pile and gives it back",
);

// Delete/Archive must not enter local dismissed state; Atlas must.
assert.equal(dismissesLocally("atlas"), true);
assert.equal(dismissesLocally("delete"), false);
assert.equal(dismissesLocally("archive"), false);
assert.match(source, /dismissesLocally\(action\)/, "Atlas alone updates local dismissed ids");
assert.match(
  source,
  /void onCommands\(picked\.map\(\(row\) => commandFor\(row, action\)\)\)/,
  "one command batch is sent per settle",
);
assert.doesNotMatch(source, /tri-settled/, "no duplicate local undo strip");
assert.doesNotMatch(
  source,
  /type: "restore"/,
  "provider undo lives on the mailbox/outbox notice, not TriageList",
);

const verbSource = await fs.readFile("src/lib/v3/mailbox/triage-verb.ts", "utf8");
assert.match(
  verbSource,
  /Presentation only/,
  "grouping comments state this does not mint delete tokens",
);
assert.match(
  verbSource,
  /does not bypass automated deletion safety/,
  "grouping does not weaken automated deletion safety",
);

console.log("v3-triage-verb: OK");
