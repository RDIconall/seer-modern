import type { Command } from "@/lib/v2/commands/types";

/** A triage row; only rows the server authorized for deletion carry a token. */
export type TriageActionRow = {
  conversationId: string;
  deleteToken?: string;
};

/**
 * Choose the command for one row.
 *
 * Deleting requires the signed token the server minted for that exact
 * decision. A row without one was never authorized for deletion — often
 * because the safety layer vetoed it — so it archives instead. This keeps a
 * bulk "Delete these" over a mixed set from escalating into deletes the
 * safety layer explicitly refused, which is the whole point of the veto.
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
