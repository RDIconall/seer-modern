import { accountKey, kvGet, kvSet } from "@/lib/store/kv";
import type { Brief, Matter } from "@/lib/inbox/matters";

/**
 * CLOSED MATTERS — durable closure records so a finished concern never
 * silently resurrects on the next rebuild. A closure is written when the
 * user (or, later, an authoritative system) closes a matter; the matters
 * pass suppresses any rebuilt matter whose identity matches a closure,
 * UNLESS new mail arrived after it closed — then it reopens explicitly.
 *
 * This is the memory the old engine lacked: archiving a whole matter
 * taught nothing, so the model rebuilt it from leftover threads.
 */

export type MatterClosure = {
  matterId: string;
  /** Meaningful title words at close time — catches re-invented ids */
  titleTokens: string[];
  /** Threads that belonged to the matter when it closed */
  threadIds: string[];
  closedAt: string;
  reason: string;
  by: "user" | "system" | "seer";
  /** Snapshot keeps the matter visible in the whiteboard's Settled column. */
  matter?: Matter;
  /** Where it was handed off, if it left for a system of record */
  handoff?: { provider: string; recordId?: string; url?: string };
};

export type ClosedMatters = Record<string, MatterClosure>;

function keyFor(accountEmail: string) {
  return `closed-matters:${accountKey(accountEmail)}`;
}

export async function loadClosedMatters(
  accountEmail: string,
): Promise<ClosedMatters> {
  return (await kvGet<ClosedMatters>(keyFor(accountEmail))) ?? {};
}

export async function saveClosedMatters(
  accountEmail: string,
  closed: ClosedMatters,
): Promise<void> {
  await kvSet(keyFor(accountEmail), closed);
}

const TITLE_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "re", "fwd", "on", "in",
  "with", "from", "at", "by", "new", "update", "updates", "follow", "up",
  "email", "emails", "thread", "threads", "status", "about", "your", "our",
]);

/** A matter's identity reduced to its meaningful words (plurals folded). */
export function titleTokensOf(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !TITLE_STOP.has(w))
        .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
    ),
  ];
}

export async function closeMatter(
  accountEmail: string,
  closure: Omit<MatterClosure, "closedAt"> & { closedAt?: string },
): Promise<ClosedMatters> {
  const closed = await loadClosedMatters(accountEmail);
  closed[closure.matterId] = {
    ...closure,
    closedAt: closure.closedAt ?? new Date().toISOString(),
  };
  await saveClosedMatters(accountEmail, closed);
  return closed;
}

export async function reopenMatter(
  accountEmail: string,
  matterId: string,
): Promise<ClosedMatters> {
  const closed = await loadClosedMatters(accountEmail);
  if (closed[matterId]) {
    delete closed[matterId];
    await saveClosedMatters(accountEmail, closed);
  }
  return closed;
}

/** Put a settled snapshot back into the active brief before deleting closure. */
export function restoreClosureMatter(
  brief: Brief,
  closure: MatterClosure,
): Brief {
  const matter = closure.matter;
  if (!matter || brief.matters.some((m) => m.id === matter.id)) return brief;
  const added = new Set(matter.emailIds).size;
  return {
    ...brief,
    matters: [matter, ...brief.matters],
    totalInbox:
      brief.totalInbox != null ? brief.totalInbox + added : brief.totalInbox,
    providerTotal: brief.providerTotal
      ? {
          ...brief.providerTotal,
          messages: brief.providerTotal.messages + added,
        }
      : brief.providerTotal,
  };
}

/**
 * Does a rebuilt matter match a closure? Same id, or a shared thread, or
 * the same meaningful title words. Partial title overlap is not identity:
 * titles come from mail content, so anyone who can mail the inbox can make
 * a new thread's title overlap a closed one.
 */
export function matchesClosure(
  m: { id: string; title: string; threadIds: string[] },
  closure: MatterClosure,
): boolean {
  if (m.id === closure.matterId) return true;
  if (m.threadIds.some((t) => closure.threadIds.includes(t))) return true;
  const a = new Set(titleTokensOf(m.title));
  const b = new Set(closure.titleTokens);
  if (a.size === 0 || a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

/** The closure a rebuilt matter belongs to, preferring one that shares a thread. */
export function closureFor(
  m: { id: string; title: string; threadIds: string[] },
  closed: ClosedMatters,
): MatterClosure | undefined {
  const all = Object.values(closed);
  return (
    all.find((c) => m.threadIds.some((t) => c.threadIds.includes(t))) ??
    all.find((c) => matchesClosure(m, c))
  );
}

/**
 * The threads whose new mail may reopen a closure: only those recorded on
 * it. Newer mail on any other thread is a different conversation and must
 * never erase the closure.
 */
export function closedThreadsOf(
  threadIds: string[],
  closure: MatterClosure,
): string[] {
  return threadIds.filter((t) => closure.threadIds.includes(t));
}
