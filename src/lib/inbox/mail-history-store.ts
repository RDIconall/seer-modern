import {
  buildMailHistory,
  type MailHistory,
} from "@/lib/inbox/mail-history";
import type { MailMessageListItem } from "@/lib/mail/types";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

const TTL_MS = 15 * 60 * 1000;
/** The archive changes slowly — re-scanning it every 15min burned
 *  ~1000 Gmail quota units per rebuild for identical results. */
const KEPT_TTL_MS = 6 * 60 * 60 * 1000;

type KeptScanFile = {
  builtAt: string;
  /** Slim rows — only what buildMailHistory reads from archived mail */
  items: Pick<
    MailMessageListItem,
    "id" | "threadId" | "fromEmail" | "fromName" | "isUnread" | "receivedAt"
  >[];
};

function keptKey(accountEmail: string) {
  return `kept-scan:${accountKey(accountEmail)}`;
}

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
  /** Read-and-archived mail — the "I signed up for this" evidence. */
  listArchive?: (
    accessToken: string,
    max: number,
  ) => Promise<MailMessageListItem[]>;
};

/** Load or rebuild relationship graph (sent + inbox + kept archive). */
export async function getOrBuildMailHistory(
  accountEmail: string,
  accessToken: string,
  loader: HistoryLoader,
  inboxSample?: MailMessageListItem[],
): Promise<MailHistory> {
  const cached = await loadCachedHistory(accountEmail);
  if (cached) return cached;

  const loadArchived = async (): Promise<KeptScanFile["items"]> => {
    if (!loader.listArchive) return [];
    const cached = await kvGet<KeptScanFile>(keptKey(accountEmail));
    if (
      cached &&
      Date.now() - new Date(cached.builtAt).getTime() < KEPT_TTL_MS
    ) {
      return cached.items;
    }
    const full = await loader.listArchive(accessToken, 200).catch(() => []);
    const slim = full.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      isUnread: m.isUnread,
      receivedAt: m.receivedAt,
    }));
    await kvSet(keptKey(accountEmail), {
      builtAt: new Date().toISOString(),
      items: slim,
    } satisfies KeptScanFile).catch(() => {});
    return slim;
  };

  const [inbox, sent, archived] = await Promise.all([
    inboxSample
      ? Promise.resolve(inboxSample)
      : loader.listFolder(accessToken, "inbox", 50),
    loader.listFolder(accessToken, "sent", 80),
    loadArchived(),
  ]);
  const history = buildMailHistory(accountEmail, inbox, sent, archived);
  await saveCachedHistory(history);
  return history;
}
