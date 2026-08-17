import type { Command } from "@/lib/v2/commands/types";

/** A triage row; only rows the server authorized for deletion carry a token. */
export type TriageActionRow = {
  conversationId: string;
  deleteToken?: string | null;
};

/**
 * The command for one row when SEER is acting over a pile.
 *
 * Deleting this way requires the signed token the server minted for that exact
 * decision. A row without one was never cleared for deletion — often because
 * the safety layer vetoed it — so it archives instead. That keeps a one-press
 * sweep over a pile the user has not read row by row from reaching past what
 * safety allowed, which is the whole point of the veto.
 */
export function commandFor(
  row: TriageActionRow,
  mode: "archive" | "trash",
): Command {
  if (mode === "trash" && row.deleteToken) {
    return {
      type: "delete",
      conversationId: row.conversationId,
      deleteToken: row.deleteToken,
    };
  }
  return { type: "archive", conversationId: row.conversationId };
}

/**
 * The command for one row when THE USER is acting on it, having picked it out
 * themselves.
 *
 * This one deletes whatever it is pointed at. Seer's reading of a conversation
 * is a recommendation, and a recommendation that can veto its reader is not a
 * recommendation — it is a lock on their own mailbox. The safety layer still
 * does its work where it belongs: on what Seer proposes, and on what a sweep is
 * allowed to take.
 */
export function userCommandFor(
  row: TriageActionRow,
  mode: "archive" | "trash",
): Command {
  if (mode === "trash") {
    return { type: "delete", conversationId: row.conversationId, byUser: true };
  }
  return { type: "archive", conversationId: row.conversationId };
}
