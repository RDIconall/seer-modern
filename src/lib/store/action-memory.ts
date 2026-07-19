import type { TriageAction } from "@/lib/inbox/classify";
import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Implicit teaching: every archive/trash the user performs is recorded
 * per sender. Once a sender shows a consistent pattern, Seer applies it
 * automatically — the user's own behavior is the best predictor of
 * their next action.
 */

export type SenderActionStats = {
  archive: number;
  trash: number;
  lastAt: string;
};

export type ActionMemory = Record<string, SenderActionStats>;

export type LearnedPrior = {
  action: TriageAction;
  dominant: "archive" | "trash";
  count: number;
  total: number;
};

const MIN_ACTIONS = 3;
const MIN_CONSISTENCY = 0.75;

function keyFor(accountEmail: string) {
  return `action-memory:${accountKey(accountEmail)}`;
}

export async function loadActionMemory(
  accountEmail: string,
): Promise<ActionMemory> {
  return (await kvGet<ActionMemory>(keyFor(accountEmail))) ?? {};
}

export async function recordSenderAction(
  accountEmail: string,
  fromEmail: string,
  action: "archive" | "trash",
): Promise<void> {
  const key = fromEmail.toLowerCase().trim();
  if (!key.includes("@")) return;
  const all = await loadActionMemory(accountEmail);
  const stat = all[key] ?? { archive: 0, trash: 0, lastAt: "" };
  stat[action] += 1;
  stat.lastAt = new Date().toISOString();
  all[key] = stat;
  await kvSet(keyFor(accountEmail), all);
}

/**
 * A sender earns a learned prior after MIN_ACTIONS consistent actions:
 * repeatedly trashed → delete without reading; repeatedly archived →
 * skim and archive.
 */
export function learnedPrior(
  memory: ActionMemory | null | undefined,
  fromEmail: string,
): LearnedPrior | null {
  const stat = memory?.[fromEmail.toLowerCase().trim()];
  if (!stat) return null;
  const total = stat.archive + stat.trash;
  if (total < MIN_ACTIONS) return null;
  const dominant = stat.trash >= stat.archive ? "trash" : "archive";
  const count = dominant === "trash" ? stat.trash : stat.archive;
  if (count / total < MIN_CONSISTENCY) return null;
  return {
    action: dominant === "trash" ? "delete_now" : "read_and_archive",
    dominant,
    count,
    total,
  };
}
