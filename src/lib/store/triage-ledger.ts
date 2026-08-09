import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE CLEANED LEDGER — an append-only record of everything Triage did on
 * the user's behalf (auto or confirmed), so nothing leaves the inbox
 * invisibly and every action can be undone. This is also the substrate
 * the autonomy ladder learns from: an undo is a reversal.
 */

export type LedgerKind =
  | "matter-closed"
  | "matter-handoff"
  | "sweep"
  | "archive"
  | "trash";

export type LedgerEntry = {
  id: string;
  at: string;
  kind: LedgerKind;
  /** Human line: "Closed 'Roche anti-TPO SOW' — executed, PO issued" */
  summary: string;
  /** The reason bucket (drives reason-level autonomy learning) */
  reason?: string;
  /** How it happened — proposed+confirmed, fully automatic, or manual */
  source: "auto" | "confirmed" | "manual";
  /** What must be restored to undo — provider ids */
  emailIds?: string[];
  threadIds?: string[];
  /** For matter actions — so undo can reopen the closure */
  matterId?: string;
  undone?: boolean;
  undoneAt?: string;
};

export type Ledger = { entries: LedgerEntry[] };

/** Keep the ledger bounded — the most recent actions are what matter. */
const MAX_ENTRIES = 500;

function keyFor(accountEmail: string) {
  return `triage-ledger:${accountKey(accountEmail)}`;
}

export async function loadLedger(accountEmail: string): Promise<Ledger> {
  return (await kvGet<Ledger>(keyFor(accountEmail))) ?? { entries: [] };
}

export async function appendLedger(
  accountEmail: string,
  entry: Omit<LedgerEntry, "id" | "at"> & { id?: string; at?: string },
): Promise<LedgerEntry> {
  const ledger = await loadLedger(accountEmail);
  const full: LedgerEntry = {
    ...entry,
    id: entry.id ?? `led-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? new Date().toISOString(),
  };
  ledger.entries.unshift(full);
  if (ledger.entries.length > MAX_ENTRIES) {
    ledger.entries = ledger.entries.slice(0, MAX_ENTRIES);
  }
  await kvSet(keyFor(accountEmail), ledger);
  return full;
}

export async function getLedgerEntry(
  accountEmail: string,
  id: string,
): Promise<LedgerEntry | null> {
  const ledger = await loadLedger(accountEmail);
  return ledger.entries.find((e) => e.id === id) ?? null;
}

export async function markUndone(
  accountEmail: string,
  id: string,
): Promise<void> {
  const ledger = await loadLedger(accountEmail);
  const e = ledger.entries.find((x) => x.id === id);
  if (e) {
    e.undone = true;
    e.undoneAt = new Date().toISOString();
    await kvSet(keyFor(accountEmail), ledger);
  }
}
