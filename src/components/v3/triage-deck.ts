import type { Command } from "@/lib/v2/commands/types";
import type { IrrelevanceReason } from "@/lib/v2/intelligence/mailbox-style";
import type { MailboxRow } from "@/lib/v3/mailbox/types";

/**
 * The triage deck: one conversation at a time, decided and gone.
 *
 * A list asks you to decide what to look at before you decide what to do,
 * which for four hundred rows is the expensive half. A deck removes that
 * choice — the next card is simply the next one — and the cost of a decision
 * drops to a single gesture.
 *
 * The state lives here rather than in the component because the dangerous part
 * of "swipe to clear" is what the gesture is allowed to mean, and that deserves
 * to be tested on its own.
 */

export type DeckVerdict = "matter" | "archive" | "delete";

export type DeckState = {
  /** The rows still to be decided, in order. */
  queue: MailboxRow[];
  index: number;
  /** The last decision, held so it can be taken back. */
  last: { row: MailboxRow; verdict: DeckVerdict } | null;
  decided: number;
};

export function deckFrom(rows: MailboxRow[]): DeckState {
  return { queue: rows, index: 0, last: null, decided: 0 };
}

export const currentCard = (state: DeckState): MailboxRow | null =>
  state.queue[state.index] ?? null;

/** The cards stacked behind the top one, nearest first. */
export const upcoming = (state: DeckState, depth = 2): MailboxRow[] =>
  state.queue.slice(state.index + 1, state.index + 1 + depth);

export const isFinished = (state: DeckState): boolean =>
  state.index >= state.queue.length;

/**
 * What a verdict actually does.
 *
 * "delete" is a request, not an instruction: a card the server never authorized
 * for deletion carries no token, and `commandFor` turns the request into an
 * archive. A gesture must not be able to reach further than a button would —
 * swiping is faster, and speed is exactly why it must not escalate.
 *
 * "matter" is the third destination, and it has to send something: a verdict
 * that wrote nothing left the conversation in the inbox to be triaged again
 * tomorrow, which is the opposite of deciding.
 */
export function commandForVerdict(
  row: MailboxRow,
  verdict: DeckVerdict,
): Command {
  return {
    type: "triageConversation",
    conversationId: row.conversationId,
    destination: verdict,
  };
}

export function commandForRelevance(
  row: MailboxRow,
  relevant: boolean,
  reason?: IrrelevanceReason | null,
): Command {
  return {
    type: "trainRelevance",
    conversationId: row.conversationId,
    relevant,
    reason: relevant ? null : (reason ?? "never_was"),
  };
}

export function decide(state: DeckState, verdict: DeckVerdict): DeckState {
  const row = currentCard(state);
  if (!row) return state;
  return {
    ...state,
    index: state.index + 1,
    last: { row, verdict },
    decided: state.decided + 1,
  };
}

/**
 * Take back the last decision. The card returns to the top of the deck, which
 * is where the user is looking — putting it back in its original position would
 * be honest to the queue and useless to the person.
 */
export function undoLast(state: DeckState): DeckState {
  if (!state.last || state.index === 0) return state;
  return {
    ...state,
    index: state.index - 1,
    last: null,
    decided: Math.max(0, state.decided - 1),
  };
}

/**
 * Fold new server rows into a deck without losing the user's place. Rows they
 * have already decided stay decided; anything new joins the back of the queue.
 */
export function reconcile(state: DeckState, rows: MailboxRow[]): DeckState {
  const seen = new Set(state.queue.slice(0, state.index).map((r) => r.conversationId));
  const remaining = rows.filter((row) => !seen.has(row.conversationId));
  const decidedRows = state.queue.slice(0, state.index);
  return {
    queue: [...decidedRows, ...remaining],
    index: decidedRows.length,
    last: state.last,
    decided: state.decided,
  };
}
