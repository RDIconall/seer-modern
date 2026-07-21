/**
 * Threads, not messages — the same conversation shows as ONE row, the
 * way Gmail renders it. The single exception: when someone changes the
 * recipient group mid-thread (drops the cc list and writes just to
 * you), that message is a different conversation in spirit and gets
 * its own row instead of hiding under the group thread.
 */

type ThreadItem = {
  id: string;
  threadId: string;
  receivedAt: string;
  participants?: string[];
};

/** Stable key for "who is in this conversation". */
function groupKey(item: ThreadItem): string {
  const set = (item.participants ?? [])
    .map((p) => p.toLowerCase().trim())
    .filter(Boolean)
    .sort();
  // No participant data (Outlook list, older cache) → thread only
  return set.length > 0 ? `${item.threadId}|${set.join(",")}` : item.threadId;
}

/**
 * One row per thread+recipient-group, represented by its NEWEST
 * message (whose classification the thread-turn logic already made
 * authoritative). Row order follows the input; `threadCount` carries
 * how many inbox messages collapsed underneath.
 */
export function collapseThreads<T extends ThreadItem>(
  items: T[],
): (T & { threadCount: number })[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = groupKey(item);
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }

  const out: (T & { threadCount: number })[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const k = groupKey(item);
    if (emitted.has(k)) continue;
    emitted.add(k);
    const list = groups.get(k) ?? [item];
    const newest = list.reduce((a, b) =>
      new Date(b.receivedAt).getTime() > new Date(a.receivedAt).getTime()
        ? b
        : a,
    );
    out.push({ ...newest, threadCount: list.length });
  }
  return out;
}
