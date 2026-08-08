import type { MailMessageListItem } from "@/lib/mail/types";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * One hydrated inbox per minute, shared by every route. Hydrating ~90
 * messages costs ~450 Gmail quota units; the triage tab, the inbox tab,
 * and a pull-to-refresh within the same minute were each paying it —
 * that's how per-user-per-minute quota blows. Sub-minute staleness is
 * already handled by the client's tombstones.
 */

const TTL_MS = 55 * 1000;

type Snapshot = {
  builtAt: string;
  items: MailMessageListItem[];
};

function keyFor(accountEmail: string) {
  return `inbox-snap:${accountKey(accountEmail)}`;
}

export async function getInboxSnapshot(
  accountEmail: string,
  fetcher: () => Promise<MailMessageListItem[]>,
  opts?: { force?: boolean },
): Promise<MailMessageListItem[]> {
  if (!opts?.force) {
    const cached = await kvGet<Snapshot>(keyFor(accountEmail)).catch(
      () => null,
    );
    if (
      cached &&
      Date.now() - new Date(cached.builtAt).getTime() < TTL_MS
    ) {
      return cached.items;
    }
  }
  const items = await fetcher();
  await kvSet(keyFor(accountEmail), {
    builtAt: new Date().toISOString(),
    items,
  } satisfies Snapshot).catch(() => {});
  return items;
}
