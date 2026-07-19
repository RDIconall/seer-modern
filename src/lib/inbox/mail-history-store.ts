import {
  buildMailHistory,
  type MailHistory,
} from "@/lib/inbox/mail-history";
import type { MailMessageListItem } from "@/lib/mail/types";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");
const TTL_MS = 15 * 60 * 1000;

type CacheFile = {
  builtAt: string;
  history: MailHistory;
};

function cachePath(accountEmail: string) {
  const safe = accountEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return path.join(DATA_DIR, `mail-history-${safe}.json`);
}

export async function loadCachedHistory(
  accountEmail: string,
): Promise<MailHistory | null> {
  try {
    const raw = await fs.readFile(cachePath(accountEmail), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    const age = Date.now() - new Date(parsed.builtAt).getTime();
    if (age > TTL_MS) return null;
    return parsed.history;
  } catch {
    return null;
  }
}

export async function saveCachedHistory(history: MailHistory) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: CacheFile = { builtAt: history.builtAt, history };
  await fs.writeFile(
    cachePath(history.accountEmail),
    JSON.stringify(payload),
    "utf8",
  );
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
