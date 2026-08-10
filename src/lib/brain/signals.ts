/**
 * THE WORK-SIGNAL CONTRACT — one normalized shape for every "what the
 * user is actually doing" source, so the brain never learns provider
 * quirks. A file edited in Drive, a note written, a document opened, or
 * time logged in Timeglass all arrive as the same record and join to
 * matters by the same keys (codes, counterparties, people, filenames).
 *
 * This is the seam that makes email silence stop meaning death: a matter
 * with no mail but a document edited yesterday is demonstrably ALIVE.
 * Connectors (Timeglass over MCP, Drive/OneDrive/SharePoint) are added
 * behind `WorkSignalAdapter` without touching the brain.
 */

export type WorkSignalKind =
  | "edit"
  | "open"
  | "create"
  | "note"
  | "time"
  | "project";

export type WorkSignal = {
  at: string;
  kind: WorkSignalKind;
  /** File/note/project title, or the logged activity */
  label: string;
  /** Folder path / workspace — carries the user's own taxonomy */
  path?: string;
  /** Codes and counterparties parsed from the name/path */
  entities: string[];
  /** For time entries */
  minutes?: number;
  source: "drive" | "onedrive" | "sharepoint" | "notes" | "timeglass";
  /** Provider id for dedupe/audit */
  ref?: string;
};

export type WorkSignalAdapter = {
  source: WorkSignal["source"];
  /** Recent work signals for this account, newest first. */
  recent: (opts: {
    accountEmail: string;
    sinceMs?: number;
    limit?: number;
  }) => Promise<WorkSignal[]>;
};

/**
 * Run every registered adapter and merge their signals, newest first.
 * Returns empty when nothing is connected — the brain degrades cleanly.
 */
export async function collectWorkSignals(
  adapters: WorkSignalAdapter[],
  opts: { accountEmail: string; sinceMs?: number; limit?: number },
): Promise<WorkSignal[]> {
  if (adapters.length === 0) return [];
  const results = await Promise.allSettled(
    adapters.map((a) => a.recent(opts)),
  );
  const all: WorkSignal[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  all.sort((a, b) => (a.at < b.at ? 1 : -1));
  return typeof opts.limit === "number" ? all.slice(0, opts.limit) : all;
}

/** The most recent work signal that mentions any of the given entities. */
export function latestSignalFor(
  signals: WorkSignal[],
  entities: string[],
): WorkSignal | null {
  if (signals.length === 0 || entities.length === 0) return null;
  const wanted = new Set(entities.map((e) => e.toLowerCase()));
  for (const s of signals) {
    if (s.entities.some((e) => wanted.has(e.toLowerCase()))) return s;
  }
  return null;
}
