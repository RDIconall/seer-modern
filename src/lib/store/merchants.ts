import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * THE MERCHANT GRAPH — who charges the user, how much, how often.
 * Built passively from receipts/bills flowing through triage. Powers
 * anomaly detection ("Crystal Waters is usually $140 — this one is
 * $410") and gives the AI the money baseline for every biller.
 */

export type MerchantRecord = {
  key: string;
  name: string;
  /** Recent charge amounts, newest last (capped) */
  amounts: number[];
  count: number;
  lastAt: string;
};

export type MerchantDb = Record<string, MerchantRecord>;

const MAX_AMOUNTS = 12;
const MAX_MERCHANTS = 500;
/** Charges after which a biller's history outranks any first-time sender. */
const BASELINE_MIN_CHARGES = 2;
/** A biller this quiet has stopped billing (covers annual charges). */
const STALE_MS = 400 * 24 * 60 * 60 * 1000;

function keyFor(accountEmail: string) {
  return `merchants:${accountKey(accountEmail)}`;
}

/** Largest dollar figure in the text — the money in motion. */
export function extractAmount(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0 && n < 10_000_000) {
      if (max == null || n > max) max = n;
    }
  }
  return max;
}

export function merchantKey(fromEmail: string): string {
  const domain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  // Collapse mail subdomains: email.chase.com → chase.com
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

export async function loadMerchants(
  accountEmail: string,
): Promise<MerchantDb> {
  return (await kvGet<MerchantDb>(keyFor(accountEmail))) ?? {};
}

function isStale(rec: MerchantRecord, now: number): boolean {
  const at = Date.parse(rec.lastAt);
  return !Number.isFinite(at) || now - at > STALE_MS;
}

/**
 * True when a first-time sender may take this record's slot: a one-off
 * charge, or a biller that has gone quiet. An active multi-charge
 * baseline is never displaced by a newcomer.
 */
function isDisplaceable(rec: MerchantRecord, now: number): boolean {
  return rec.amounts.length < BASELINE_MIN_CHARGES || isStale(rec, now);
}

/** Oldest displaceable record, or null when every slot is a live baseline. */
function displaceableKey(db: MerchantDb): string | null {
  const now = Date.now();
  let pick: string | null = null;
  for (const [k, rec] of Object.entries(db)) {
    if (!isDisplaceable(rec, now)) continue;
    if (pick == null || rec.lastAt < db[pick].lastAt) pick = k;
  }
  return pick;
}

export async function saveMerchants(
  accountEmail: string,
  db: MerchantDb,
): Promise<void> {
  const keys = Object.keys(db);
  if (keys.length > MAX_MERCHANTS) {
    // recordCharge keeps the table within the cap; this only trims a
    // table that arrived oversized, still dropping live baselines last.
    const now = Date.now();
    keys
      .sort((a, b) => {
        const keepA = isDisplaceable(db[a], now) ? 0 : 1;
        const keepB = isDisplaceable(db[b], now) ? 0 : 1;
        if (keepA !== keepB) return keepA - keepB;
        return db[a].lastAt < db[b].lastAt ? -1 : 1;
      })
      .slice(0, keys.length - MAX_MERCHANTS)
      .forEach((k) => delete db[k]);
  }
  await kvSet(keyFor(accountEmail), db);
}

/**
 * Learn one charge. When the table is full, a first-time domain is
 * stored only if `mayDisplace` (the grade itself called it money, not
 * just a subject line the sender wrote) and a one-off or long-quiet
 * record can give up its slot. Returns false when nothing was stored.
 */
export function recordCharge(
  db: MerchantDb,
  fromEmail: string,
  fromName: string,
  amount: number,
  opts: { mayDisplace: boolean },
): boolean {
  const key = merchantKey(fromEmail);
  if (!key) return false;
  let rec = db[key];
  if (!rec) {
    if (Object.keys(db).length >= MAX_MERCHANTS) {
      if (!opts.mayDisplace) return false;
      const victim = displaceableKey(db);
      if (victim == null) return false;
      delete db[victim];
    }
    rec = { key, name: fromName || key, amounts: [], count: 0, lastAt: "" };
  }
  rec.amounts.push(amount);
  if (rec.amounts.length > MAX_AMOUNTS) rec.amounts.shift();
  rec.count += 1;
  rec.lastAt = new Date().toISOString();
  db[key] = rec;
  return true;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** "usually ~$140 (6 charges)" — the AI's money baseline for a biller. */
export function usualLabel(
  db: MerchantDb,
  fromEmail: string,
): string | null {
  const rec = db[merchantKey(fromEmail)];
  if (!rec || rec.amounts.length < 2) return null;
  return `usually ~$${median(rec.amounts).toFixed(0)} (${rec.count} charges)`;
}

/** True when this amount is wildly off the sender's baseline. */
export function isAnomalousCharge(
  db: MerchantDb,
  fromEmail: string,
  amount: number,
): boolean {
  const rec = db[merchantKey(fromEmail)];
  if (!rec || rec.amounts.length < 3) return false;
  const med = median(rec.amounts);
  return med > 0 && amount >= 100 && amount >= med * 2.5;
}