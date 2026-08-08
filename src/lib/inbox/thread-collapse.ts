/**
 * Threads, not messages — the same conversation shows as ONE row, the
 * way Gmail renders it: strictly one row per thread id, labeled with a
 * Gmail-style participant summary ("Rebecca, You · 3"). An earlier
 * version forked rows when the recipient group changed mid-thread —
 * real threads vary their cc lists constantly, so that fragmented one
 * conversation into several confusing rows.
 */

type ThreadItem = {
  id: string;
  threadId: string;
  receivedAt: string;
  fromEmail: string;
  fromName: string;
};

/**
 * One row per thread, represented by its NEWEST message (whose
 * classification the thread-turn logic already made authoritative).
 * `threadSenders` lists distinct senders chronologically (Gmail's
 * "fs2117, me, Faisal"); `threadCount` is how many inbox messages
 * collapsed underneath.
 */
export function collapseThreads<T extends ThreadItem>(
  items: T[],
): (T & { threadCount: number; threadSenders?: string[] })[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.threadId) ?? [];
    list.push(item);
    groups.set(item.threadId, list);
  }

  const out: (T & { threadCount: number; threadSenders?: string[] })[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    if (emitted.has(item.threadId)) continue;
    emitted.add(item.threadId);
    const list = [...(groups.get(item.threadId) ?? [item])].sort(
      (a, b) =>
        new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );
    const newest = list[list.length - 1];

    // Distinct senders in speaking order, first names only — like
    // Gmail's thread row. ("You" arrives pre-labeled from the routes.)
    const senders: string[] = [];
    const seen = new Set<string>();
    for (const m of list) {
      const k = m.fromEmail.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const raw = m.fromName || m.fromEmail;
      // "Bates, Rebecca J" is Last-comma-First — the display name is
      // the token AFTER the comma ("Rebecca"), like Gmail shows it.
      const source = raw.includes(",")
        ? (raw.split(",")[1]?.trim() ?? raw)
        : raw;
      const first =
        m.fromName === "You"
          ? "You"
          : source.split(/[\s@]+/)[0] || m.fromEmail;
      senders.push(first);
    }

    out.push({
      ...newest,
      threadCount: list.length,
      threadSenders: senders.length > 1 ? senders.slice(0, 4) : undefined,
    });
  }
  return out;
}
