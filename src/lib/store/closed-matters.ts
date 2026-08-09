import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

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

/**
 * Does a rebuilt matter match a closure? Same id, or a shared thread, or
 * fully-overlapping meaningful title words (so "Roche SOW" and "Roche
 * anti-TPO SOW" are recognized as the same closed concern).
 */
export function matchesClosure(
  m: { id: string; title: string; threadIds: string[] },
  closure: MatterClosure,
): boolean {
  if (m.id === closure.matterId) return true;
  if (m.threadIds.some((t) => closure.threadIds.includes(t))) return true;
  const a = new Set(titleTokensOf(m.title));
  const b = new Set(closure.titleTokens);
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (!big.has(w)) return false;
  return small.size >= 2 || small.size === big.size;
}
