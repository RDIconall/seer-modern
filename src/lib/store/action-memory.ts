import type { TriageAction } from "@/lib/inbox/classify";
import { promises as fs } from "fs";
import path from "path";

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

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");
const MIN_ACTIONS = 3;
const MIN_CONSISTENCY = 0.75;

function fileFor(accountEmail: string) {
  const safe = accountEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return path.join(DATA_DIR, `action-memory-${safe}.json`);
}

export async function loadActionMemory(
  accountEmail: string,
): Promise<ActionMemory> {
  try {
    const raw = await fs.readFile(fileFor(accountEmail), "utf8");
    return JSON.parse(raw) as ActionMemory;
  } catch {
    return {};
  }
}

export async function recordSenderAction(
  accountEmail: string,
  fromEmail: string,
  action: "archive" | "trash",
): Promise<void> {
  const key = fromEmail.toLowerCase().trim();
  if (!key.includes("@")) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const all = await loadActionMemory(accountEmail);
  const stat = all[key] ?? { archive: 0, trash: 0, lastAt: "" };
  stat[action] += 1;
  stat.lastAt = new Date().toISOString();
  all[key] = stat;
  await fs.writeFile(fileFor(accountEmail), JSON.stringify(all), "utf8");
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
