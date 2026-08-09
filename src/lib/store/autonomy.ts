import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE AUTONOMY LADDER — per-REASON trust, earned by evidence, not a
 * global switch. A reason starts as a proposal; it graduates to acting
 * on its own only after many accepted proposals with almost no reversals,
 * and it is demoted instantly the moment the user reverses it. Promotion
 * is slow; demotion is immediate. Seer's own automatic actions never
 * count as approval, so it cannot train itself into confidence.
 */

export type ReasonPolicy = {
  reason: string;
  mode: "propose" | "auto";
  /** Accepted proposals (a positive signal from the user) */
  accepted: number;
  /** Reversals within the trailing window (undo / untick) */
  reversed: number;
  /** Rolling count of recent auto-actions, to bound the reversal window */
  recentAuto: number;
  updatedAt: string;
};

export type AutonomyStore = { reasons: Record<string, ReasonPolicy> };

/** Reasons that ship acting on their own — deterministic and proven-safe. */
const DEFAULT_AUTO = new Set<string>([
  "expired-by-date",
  "learned-sender",
  "rsvp-receipt",
]);

/** Promotion gate: enough accepted proposals, almost no reversals. */
const PROMOTE_MIN_ACCEPTED = 20;
const PROMOTE_MAX_REVERSAL_RATE = 0.02;
/** Demotion: this many reversals in the trailing window flips it back. */
const DEMOTE_REVERSALS = 2;
const REVERSAL_WINDOW = 20;

function keyFor(accountEmail: string) {
  return `autonomy:${accountKey(accountEmail)}`;
}

export async function loadAutonomy(
  accountEmail: string,
): Promise<AutonomyStore> {
  return (await kvGet<AutonomyStore>(keyFor(accountEmail))) ?? { reasons: {} };
}

async function save(accountEmail: string, store: AutonomyStore) {
  await kvSet(keyFor(accountEmail), store);
}

function ensure(store: AutonomyStore, reason: string): ReasonPolicy {
  if (!store.reasons[reason]) {
    store.reasons[reason] = {
      reason,
      mode: DEFAULT_AUTO.has(reason) ? "auto" : "propose",
      accepted: 0,
      reversed: 0,
      recentAuto: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return store.reasons[reason];
}

/** Is this reason allowed to act on its own right now? */
export async function reasonMode(
  accountEmail: string,
  reason: string,
): Promise<"propose" | "auto"> {
  const store = await loadAutonomy(accountEmail);
  return store.reasons[reason]?.mode ?? (DEFAULT_AUTO.has(reason) ? "auto" : "propose");
}

/** The user accepted a proposal for this reason — evidence toward auto. */
export async function recordAccepted(
  accountEmail: string,
  reason: string,
): Promise<ReasonPolicy> {
  const store = await loadAutonomy(accountEmail);
  const p = ensure(store, reason);
  p.accepted += 1;
  const rate = p.reversed / Math.max(1, p.accepted);
  if (
    p.mode === "propose" &&
    p.accepted >= PROMOTE_MIN_ACCEPTED &&
    rate <= PROMOTE_MAX_REVERSAL_RATE
  ) {
    p.mode = "auto";
  }
  p.updatedAt = new Date().toISOString();
  await save(accountEmail, store);
  return p;
}

/**
 * The user reversed an action for this reason (undo / untick). Demote to
 * propose immediately if reversals cross the threshold in the window.
 */
export async function recordReversal(
  accountEmail: string,
  reason: string,
): Promise<ReasonPolicy> {
  const store = await loadAutonomy(accountEmail);
  const p = ensure(store, reason);
  p.reversed += 1;
  if (p.reversed >= DEMOTE_REVERSALS && p.recentAuto <= REVERSAL_WINDOW) {
    p.mode = "propose";
  }
  p.updatedAt = new Date().toISOString();
  await save(accountEmail, store);
  return p;
}

/** Count an auto-action taken (bounds the reversal window). */
export async function recordAuto(
  accountEmail: string,
  reason: string,
): Promise<void> {
  const store = await loadAutonomy(accountEmail);
  const p = ensure(store, reason);
  p.recentAuto += 1;
  if (p.recentAuto > REVERSAL_WINDOW) {
    // New window — reversals must be re-earned against fresh actions
    p.recentAuto = 1;
    p.reversed = 0;
  }
  p.updatedAt = new Date().toISOString();
  await save(accountEmail, store);
}
