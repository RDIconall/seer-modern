import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Threads the user has replied to, recorded the moment they hit Send in
 * Seer (threadId → ISO time). The sent-folder scan catches replies made
 * elsewhere, but its cache lags ~15 minutes — this map makes an in-app
 * reply flip the card to "handled" instantly.
 */

export type RepliedThreads = Record<string, string>;

const MAX_ENTRIES = 400;

function keyFor(accountEmail: string) {
  return `replied:${accountKey(accountEmail)}`;
}

export async function loadRepliedThreads(
  accountEmail: string,
): Promise<RepliedThreads> {
  return (await kvGet<RepliedThreads>(keyFor(accountEmail))) ?? {};
}

export async function recordRepliedThread(
  accountEmail: string,
  threadId: string,
): Promise<void> {
  if (!threadId) return;
  const all = await loadRepliedThreads(accountEmail);
  all[threadId] = new Date().toISOString();

  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (all[a] < all[b] ? -1 : 1))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete all[k]);
  }
  await kvSet(keyFor(accountEmail), all);
}
