import {
  UNDERSTANDING_VERSION,
  type Understanding,
  type UnderstandingMap,
} from "@/lib/inbox/understanding";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Deep reads are the expensive thing Seer does, so they are kept forever —
 * keyed by message id and read version. A message is re-read only when the
 * schema or prompt changes, or when it was never read at all.
 */

function keyFor(accountEmail: string) {
  return `understanding:${accountKey(accountEmail)}`;
}

export async function loadUnderstanding(
  accountEmail: string,
): Promise<UnderstandingMap> {
  return (await kvGet<UnderstandingMap>(keyFor(accountEmail))) ?? {};
}

export async function saveUnderstanding(
  accountEmail: string,
  map: UnderstandingMap,
): Promise<void> {
  await kvSet(keyFor(accountEmail), map);
}

/**
 * Merge fresh records in, then prune to the ids that still matter so the
 * key stays bounded as mail comes and goes.
 */
export async function mergeUnderstanding(
  accountEmail: string,
  records: Understanding[],
  keepIds?: Set<string>,
): Promise<UnderstandingMap> {
  const map = await loadUnderstanding(accountEmail);
  for (const r of records) map[r.id] = r;
  if (keepIds) {
    for (const id of Object.keys(map)) {
      if (!keepIds.has(id)) delete map[id];
    }
  }
  await saveUnderstanding(accountEmail, map);
  return map;
}

/** Ids still needing a read: never read, or read by an older version. */
export function unreadIds(
  ids: { id: string }[],
  map: UnderstandingMap,
): string[] {
  return ids
    .filter(({ id }) => (map[id]?.version ?? 0) < UNDERSTANDING_VERSION)
    .map(({ id }) => id);
}
