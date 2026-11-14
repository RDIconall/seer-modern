/**
 * Dollar amounts belong to a regex, not a model — models paraphrase numbers.
 * Same merchant-graph helpers the legacy triage used, without the KV store.
 */

export type MerchantRecord = {
  key: string;
  name: string;
  amounts: number[];
  count: number;
  lastAt: string;
};

export type MerchantDb = Record<string, MerchantRecord>;

const MAX_AMOUNTS = 12;

/** Largest dollar figure in the text — the money in motion. */
export function extractAmount(text: string): number | null {
  let max: number | null = null;
  for (const match of text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)) {
    const n = Number.parseFloat(match[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0 && n < 10_000_000) {
      if (max == null || n > max) max = n;
    }
  }
  return max;
}

export function merchantKey(fromEmail: string): string {
  const domain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

export function recordCharge(
  db: MerchantDb,
  fromEmail: string,
  fromName: string,
  amount: number,
  at = new Date().toISOString(),
): void {
  const key = merchantKey(fromEmail);
  if (!key) return;
  const rec = db[key] ?? {
    key,
    name: fromName || key,
    amounts: [],
    count: 0,
    lastAt: "",
  };
  rec.amounts.push(amount);
  if (rec.amounts.length > MAX_AMOUNTS) rec.amounts.shift();
  rec.count += 1;
  rec.lastAt = at;
  db[key] = rec;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** "usually ~$140 (6 charges)" — the money baseline for a biller. */
export function usualLabel(db: MerchantDb, fromEmail: string): string | null {
  const rec = db[merchantKey(fromEmail)];
  if (!rec || rec.amounts.length < 2) return null;
  return `usually ~$${median(rec.amounts).toFixed(0)} (${rec.count} charges)`;
}

export function usualAmount(db: MerchantDb, fromEmail: string): number | null {
  const rec = db[merchantKey(fromEmail)];
  if (!rec || rec.amounts.length < 2) return null;
  return median(rec.amounts);
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

export function formatUsd(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  }
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}
