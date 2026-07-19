import {
  buildMailHistory,
  type MailHistory,
} from "@/lib/inbox/mail-history";
import type { MailMessageListItem } from "@/lib/mail/types";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

const TTL_MS = 15 * 60 * 1000;

type CacheFile = {
  builtAt: string;
  history: MailHistory;
};

function keyFor(accountEmail: string) {
  return `mail-history:${accountKey(accountEmail)}`;
}

export async function loadCachedHistory(
  accountEmail: string,
): Promise<MailHistory | null> {
  const parsed = await kvGet<CacheFile>(keyFor(accountEmail));
  if (!parsed) return null;
  const age = Date.now() - new Date(parsed.builtAt).getTime();
  if (age > TTL_MS) return null;
  return parsed.history;
}

export async function saveCachedHistory(history: MailHistory) {
  const payload: CacheFile = { builtAt: history.builtAt, history };
  await kvSet(keyFor(history.accountEmail), payload);
}

type HistoryLoader = {
  listFolder: (
    accessToken: string,
    folder: "inbox" | "sent",
    max: number,
  ) => Promise<MailMessageListItem[]>;
};

/** Load or rebuild relationship graph (sent + inbox sample). Server-only. */
export async function getOrBuildMailHistory(
  accountEmail: string,
  accessToken: string,
  loader: HistoryLoader,
  inboxSample?: MailMessageListItem[],
): Promise<MailHistory> {
  const cached = await loadCachedHistory(accountEmail);
  if (cached) return cached;

  const [inbox, sent] = await Promise.all([
    inboxSample
      ? Promise.resolve(inboxSample)
      : loader.listFolder(accessToken, "inbox", 50),
    loader.listFolder(accessToken, "sent", 80),
  ]);
  const history = buildMailHistory(accountEmail, inbox, sent);
  await saveCachedHistory(history);
  return history;
}
