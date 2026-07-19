import type { Confidence, TriageAction } from "@/lib/inbox/classify";
import { promises as fs } from "fs";
import path from "path";

/**
 * Persistent per-message triage decisions so repeat inbox loads
 * never re-pay Gemini for mail it already classified.
 */

export type CachedDecision = {
  action: TriageAction;
  confidence: Confidence;
  reason: string;
  instruction?: string;
  source: "gemini" | "rules" | "override";
  ruleId: string;
  ts: number;
  v: number;
};

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

type CacheFile = Record<string, CachedDecision>;

function fileFor(accountEmail: string) {
  const safe = accountEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return path.join(DATA_DIR, `decisions-${safe}.json`);
}

async function readAll(accountEmail: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(fileFor(accountEmail), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return {};
  }
}

export async function loadDecisions(
  accountEmail: string,
  ids: string[],
  promptVersion: number,
): Promise<Map<string, CachedDecision>> {
  const all = await readAll(accountEmail);
  const now = Date.now();
  const out = new Map<string, CachedDecision>();
  for (const id of ids) {
    const hit = all[id];
    if (!hit) continue;
    if (hit.v !== promptVersion) continue;
    if (now - hit.ts > TTL_MS) continue;
    out.set(id, hit);
  }
  return out;
}

export async function saveDecisions(
  accountEmail: string,
  entries: Map<string, CachedDecision>,
): Promise<void> {
  if (entries.size === 0) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const all = await readAll(accountEmail);
  for (const [id, d] of entries) all[id] = d;

  // Evict oldest when oversized
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (all[a].ts ?? 0) - (all[b].ts ?? 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete all[k]);
  }

  await fs.writeFile(fileFor(accountEmail), JSON.stringify(all), "utf8");
}