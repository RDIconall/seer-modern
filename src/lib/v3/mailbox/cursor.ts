import type { MailboxSort } from "./types";

/**
 * Keyset cursors, one shape per sort order.
 *
 * A cursor carries every column its ordering compares, so paging never relies
 * on an offset that shifts when mail arrives mid-scroll. A cursor is also bound
 * to the sort it was minted for: handing a date cursor to the triage query
 * would silently skip rows, so a mismatched cursor is refused outright and the
 * caller starts from the top.
 */

export type MailboxCursor =
  | { sort: "date"; at: string; id: string }
  | { sort: "triage"; rank: number; priority: number; at: string; id: string };

export function encodeMailboxCursor(cursor: MailboxCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeMailboxCursor(
  before: string | null | undefined,
  sort: MailboxSort = "date",
): MailboxCursor | null {
  if (!before) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(before, "base64url").toString("utf8"),
    ) as {
      sort?: string;
      at?: unknown;
      id?: unknown;
      rank?: unknown;
      priority?: unknown;
    };
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string") return null;
    // Cursors minted before triage sort existed carry no discriminator; they
    // can only ever have been date cursors.
    const cursorSort = parsed.sort ?? "date";
    if (cursorSort !== sort) return null;
    if (cursorSort === "triage") {
      if (typeof parsed.rank !== "number" || typeof parsed.priority !== "number") {
        return null;
      }
      return {
        sort: "triage",
        rank: parsed.rank,
        priority: parsed.priority,
        at: parsed.at,
        id: parsed.id,
      };
    }
    return { sort: "date", at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}
