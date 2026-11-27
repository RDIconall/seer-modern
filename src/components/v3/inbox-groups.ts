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

export type InboxSortKey = "age" | "activity" | "from" | "subject" | "step";
export type InboxSort = { key: InboxSortKey; dir: "asc" | "desc" };

/** Oldest matter first: the order the server returns, and the one work is read in. */
export const DEFAULT_INBOX_SORT: InboxSort = { key: "age", dir: "asc" };

export const INBOX_SORT_OPTIONS: { value: string; label: string; sort: InboxSort }[] = [
  { value: "age:asc", label: "Oldest first", sort: { key: "age", dir: "asc" } },
  { value: "age:desc", label: "Newest first", sort: { key: "age", dir: "desc" } },
  { value: "activity:desc", label: "Latest activity", sort: { key: "activity", dir: "desc" } },
  { value: "activity:asc", label: "Quietest first", sort: { key: "activity", dir: "asc" } },
  { value: "from:asc", label: "From A–Z", sort: { key: "from", dir: "asc" } },
  { value: "from:desc", label: "From Z–A", sort: { key: "from", dir: "desc" } },
  { value: "subject:asc", label: "Subject A–Z", sort: { key: "subject", dir: "asc" } },
  { value: "subject:desc", label: "Subject Z–A", sort: { key: "subject", dir: "desc" } },
  { value: "step:asc", label: "Next step A–Z", sort: { key: "step", dir: "asc" } },
  { value: "step:desc", label: "Next step Z–A", sort: { key: "step", dir: "desc" } },
];

export const sortValue = (sort: InboxSort) => `${sort.key}:${sort.dir}`;

export function sortFromValue(value: string | null | undefined): InboxSort | null {
  return INBOX_SORT_OPTIONS.find((option) => option.value === value)?.sort ?? null;
}

export function sortLabel(sort: InboxSort): string {
  return (
    INBOX_SORT_OPTIONS.find((option) => option.value === sortValue(sort))?.label ??
    "Oldest first"
  );
}

/** A column header click: the same column flips direction, a new one starts ascending. */
export function nextSort(current: InboxSort, key: InboxSortKey): InboxSort {
  if (current.key !== key) return { key, dir: key === "activity" ? "desc" : "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const time = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Re-order groups for reading; the groups themselves never change. A sort never
 * splits a matter, and ties fall back to the oldest group first so the order
 * stays predictable. Subject sorts on the newest conversation in the group.
 */
export function sortGroups(groups: InboxGroup[], sort: InboxSort): InboxGroup[] {
  const direction = sort.dir === "asc" ? 1 : -1;
  const keyed = groups.map((group, index) => ({ group, index }));
  const compare = (a: InboxGroup, b: InboxGroup): number => {
    switch (sort.key) {
      case "age":
        return time(a.oldestAt) - time(b.oldestAt);
      case "activity":
        return (
          Math.max(...a.rows.map((row) => time(row.timestamp))) -
          Math.max(...b.rows.map((row) => time(row.timestamp)))
        );
      case "from":
        return collator.compare(a.title, b.title);
      case "subject":
        return collator.compare(a.rows[0].subject, b.rows[0].subject);
      case "step":
        return collator.compare(a.step.text, b.step.text);
    }
  };
  keyed.sort((x, y) => {
    const primary = compare(x.group, y.group) * direction;
    if (primary !== 0) return primary;
    const byAge = time(x.group.oldestAt) - time(y.group.oldestAt);
    return byAge !== 0 ? byAge : x.index - y.index;
  });
  return keyed.map((entry) => entry.group);
}

/** The same rows, re-ordered group by group, so keyboard paging follows the list. */
export function sortInboxRows<T extends MailboxRow>(rows: T[], sort: InboxSort): T[] {
  if (sort.key === DEFAULT_INBOX_SORT.key && sort.dir === DEFAULT_INBOX_SORT.dir) {
    return rows;
  }
  return sortGroups(groupInbox(rows), sort).flatMap((group) => group.rows) as T[];
}
