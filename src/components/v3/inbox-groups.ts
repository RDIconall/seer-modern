import type { NextStep, NextVerb } from "@/lib/v3/mailbox/next-step";
import type { MailboxRow } from "@/lib/v3/mailbox/types";

/**
 * The Inbox as the person reads it: one line per matter, or per conversation
 * that is not part of one. The server orders the rows and stamps each with its
 * group, so this only folds them together. It never decides placement.
 */

export type InboxGroup = {
  /** The server's group key: `m:<matterId>` or `c:<conversationId>`. */
  key: string;
  kind: "matter" | "single";
  matterId: string | null;
  /** Matter title, or the sender for a conversation that stands alone. */
  title: string;
  /** The part of the business this is filed under, if known. */
  section: string | null;
  /** Newest first, as the server returns them. */
  rows: MailboxRow[];
  /** When the oldest conversation in the group arrived. */
  oldestAt: string;
  /** What should happen next to the whole group. */
  step: NextStep;
  /** Only singles carry a verb; a matter's step is wording. */
  verb: NextVerb | null;
  unread: boolean;
};

export function groupInbox(rows: MailboxRow[]): InboxGroup[] {
  const byKey = new Map<string, MailboxRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.groupKey);
    if (list) list.push(row);
    else byKey.set(row.groupKey, [row]);
  }

  const groups: InboxGroup[] = [];
  for (const [key, members] of byKey) {
    const newest = members[0];
    const matterId = newest.matterId;
    const kind = matterId ? "matter" : "single";
    groups.push({
      key,
      kind,
      matterId,
      title:
        kind === "matter"
          ? newest.matterTitle || newest.subject || "Untitled matter"
          : newest.senderDisplayName || "Unknown sender",
      section: newest.category,
      rows: members,
      oldestAt: newest.groupAt,
      // A matter's wording is the same on every row once the person has edited
      // it; otherwise the newest conversation's reading is the freshest.
      step: members.find((row) => row.nextStep.source === "user")?.nextStep ?? newest.nextStep,
      verb: kind === "single" ? newest.nextStep.verb : null,
      unread: members.some((row) => row.isUnread),
    });
  }
  return groups;
}

const DAY_MS = 86_400_000;

/** Whole days since `at`, never negative; null when the date cannot be read. */
export function ageInDays(at: string, now = Date.now()): number | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

export function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date);
}

/** "Oct 16 · 41d" — when the group started and how long it has been waiting. */
export function ageLabel(at: string, now = Date.now()): string {
  const date = shortDate(at);
  const days = ageInDays(at, now);
  if (!date) return "";
  return days === null ? date : `${date} · ${days}d`;
}
