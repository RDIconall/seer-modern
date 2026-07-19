import type { Confidence, TriageAction } from "@/lib/inbox/classify";
import { accountKey, kvDelete, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Persistent per-message triage decisions so repeat inbox loads
 * never re-pay Gemini for mail it already classified.
 */

export type CachedDecision = {
  action: TriageAction;
  confidence: Confidence;
  reason: string;
  instruction?: string;
  source: "gemini" | "rules" | "override" | "learned";
  ruleId: string;
  ts: number;
  v: number;
};

const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

type CacheFile = Record<string, CachedDecision>;

function keyFor(accountEmail: string) {
  return `decisions:${accountKey(accountEmail)}`;
}

async function readAll(accountEmail: string): Promise<CacheFile> {
  return (await kvGet<CacheFile>(keyFor(accountEmail))) ?? {};
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

  await kvSet(keyFor(accountEmail), all);
}

/**
 * Drop every cached decision for an account. Used when the user's
 * profile ("about me" memory) changes — new self-knowledge can change
 * what Gemini would decide, so everything gets a fresh look.
 */
export async function clearDecisions(accountEmail: string): Promise<void> {
  await kvDelete(keyFor(accountEmail));
}