/**
 * Gate: the triage deck decides one card at a time, and a gesture can never
 * reach further than a button would.
 *
 * Swiping is fast, and speed is exactly the reason it must not escalate: a card
 * the safety layer refused to authorize for deletion carries no token, and a
 * swipe on it archives. The deck is also allowed to be taken back, because a
 * decision that cannot be undone is one people hesitate over.
 */
import assert from "node:assert/strict";
import {
  commandForVerdict,
  currentCard,
  deckFrom,
  decide,
  isFinished,
  reconcile,
  undoLast,
  upcoming,
  wouldDelete,
} from "../src/components/v3/triage-deck.ts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TriageCards } from "../src/components/v3/TriageCards.tsx";
import type { MailboxRow } from "../src/lib/v3/mailbox/types.ts";

const row = (id: string, deleteToken: string | null = null): MailboxRow => ({
  conversationId: id,
  providerConversationId: `p-${id}`,
  senderDisplayName: `Sender ${id}`,
  subject: `Subject ${id}`,
  timestamp: "2026-08-16T10:00:00.000Z",
  isUnread: false,
  snippet: "",
  attachments: [],
  decisionSummary: "Routine notice",
  priority: null,
  dueDate: null,
  matterTitle: null,
  disposition: deleteToken ? "delete" : "undecided",
  deleteRank: deleteToken ? 0 : 2,
  deleteToken,
  category: "IT notices",
  vetoReasons: deleteToken ? [] : ["personal_greeting"],
});

// --- the deck advances -------------------------------------------------------

{
  const deck = deckFrom([row("a", "t-a"), row("b"), row("c")]);
  assert.equal(currentCard(deck)?.conversationId, "a");
  assert.deepEqual(
    upcoming(deck).map((r) => r.conversationId),
    ["b", "c"],
    "the deck shows what is behind the top card",
  );

  const after = decide(deck, "archive");
  assert.equal(currentCard(after)?.conversationId, "b");
  assert.equal(after.decided, 1);
  assert.equal(isFinished(after), false);

  const end = decide(decide(after, "matter"), "delete");
  assert.equal(isFinished(end), true);
  assert.equal(currentCard(end), null);
  assert.equal(end.decided, 3);
}

// --- what a verdict is allowed to mean --------------------------------------

{
  const authorized = row("a", "t-a");
  const refused = row("b");

  assert.deepEqual(commandForVerdict(authorized, "delete"), {
    type: "delete",
    conversationId: "a",
    deleteToken: "t-a",
  });

  // The whole point: the same gesture on an unauthorized card archives.
  assert.deepEqual(commandForVerdict(refused, "delete"), {
    type: "archive",
    conversationId: "b",
  });
  assert.equal(wouldDelete(refused), false);
  assert.equal(wouldDelete(authorized), true);

  assert.deepEqual(commandForVerdict(authorized, "archive"), {
    type: "archive",
    conversationId: "a",
  });

  // The third destination has to write something: a verdict that sent no
  // command left the conversation in the inbox to be triaged again tomorrow.
  assert.deepEqual(commandForVerdict(authorized, "matter"), {
    type: "correctConversation",
    conversationId: "a",
    home: "matter",
    note: "made a matter in triage",
  });
  assert.deepEqual(commandForVerdict(refused, "matter"), {
    type: "correctConversation",
    conversationId: "b",
    home: "matter",
    note: "made a matter in triage",
  });
}

// --- taking it back ----------------------------------------------------------

{
  const deck = deckFrom([row("a", "t-a"), row("b")]);
  const decided = decide(deck, "delete");
  assert.equal(currentCard(decided)?.conversationId, "b");
  assert.equal(decided.last?.verdict, "delete");

  const back = undoLast(decided);
  assert.equal(currentCard(back)?.conversationId, "a", "the card comes back to the top");
  assert.equal(back.decided, 0);
  assert.equal(back.last, null, "one step back, not a history");

  // Nothing to undo at the start, and undoing twice does not run past the edge.
  assert.equal(undoLast(deckFrom([row("a")])).index, 0);
  assert.equal(undoLast(back).index, 0);
}

// --- new mail arriving mid-triage -------------------------------------------

{
  const deck = decide(deckFrom([row("a"), row("b"), row("c")]), "archive");
  // The server sends a fresh list: "a" is gone (it was archived), "d" is new.
  const merged = reconcile(deck, [row("b"), row("c"), row("d")]);
  assert.equal(merged.decided, 1, "work already done stays done");
  assert.equal(currentCard(merged)?.conversationId, "b", "the place is kept");
  assert.deepEqual(
    merged.queue.slice(merged.index).map((r) => r.conversationId),
    ["b", "c", "d"],
    "new mail joins the back of the queue",
  );
}

// A card already decided is not dealt again when the server still lists it.
{
  const deck = decide(deckFrom([row("a"), row("b")]), "matter");
  const merged = reconcile(deck, [row("a"), row("b")]);
  assert.equal(currentCard(merged)?.conversationId, "b");
}

// --- the deck as rendered ----------------------------------------------------

{
  const render = (rows: MailboxRow[]) =>
    renderToString(
      createElement(TriageCards, {
        rows,
        onCommands: async () => {},
        onOpen() {},
        onExit() {},
      } as never),
    ).replace(/<!--[\s\S]*?-->/g, "");

  const authorized = row("a", "t-a");
  const refused = row("b");

  const html = render([authorized, refused]);
  assert.match(html, /1 of 2/, "the deck says where you are in the pile");
  assert.match(html, /deck-card-top/);
  assert.match(html, /deck-card-behind/, "the pile is visible behind the top card");

  // The verdict is named on the card before the gesture commits.
  assert.match(html, /deck-verdict-clear[^>]*>Delete</, "an authorized card offers Delete");
  assert.match(html, /deck-verdict-keep[^>]*>Atlas</, "the third destination is named");

  // And on a card the safety layer refused, the same gesture says Archive.
  const heldHtml = render([refused]);
  assert.match(
    heldHtml,
    /deck-verdict-clear[^>]*>Archive</,
    "a refused card never offers Delete, however it is swiped",
  );
  assert.match(
    heldHtml,
    /didn’t clear this one/,
    "the card says Seer did not clear it — the button still works",
  );
  assert.doesNotMatch(heldHtml, /deck-verdict-clear[^>]*>Delete</);

  // The deck keeps the look it always had: paper on the teal field.
  assert.match(html, /seer-deck-bg/, "the deck runs on the teal field");
  assert.match(html, /seer-card-face/, "a card is the same paper it always was");
  assert.match(html, /deck-avatar/, "the sender is carried by an initial");
  assert.match(
    html,
    /deck-action-label/,
    "the actions are round buttons labelled underneath",
  );

  // An empty pile is a finished pile, not a blank screen.
  assert.match(render([]), /Nothing to triage/);
}

console.log("v3-triage-deck: OK");
