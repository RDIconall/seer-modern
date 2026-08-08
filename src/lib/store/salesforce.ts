import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * SALESFORCE REGISTRY — the live list of active studies and open
 * opportunities, by code. Atlas uses it to name the sub-branches inside
 * a function ("operations — studies" splits into RCD_2818, RD007704, …)
 * instead of dumping hundreds of emails under one heading.
 */

export type SalesforceStudy = {
  /** RCD_2818, RD007704, LMD_1234 — the code that appears in mail */
  code: string;
  name?: string;
  account?: string;
  status?: string;
};

export type SalesforceOpportunity = {
  /** RFQ or opportunity number as it appears in mail */
  code: string;
  name?: string;
  account?: string;
  stage?: string;
};

export type SalesforceRegistry = {
  studies: SalesforceStudy[];
  opportunities: SalesforceOpportunity[];
  syncedAt?: string;
};

const EMPTY: SalesforceRegistry = { studies: [], opportunities: [] };

function keyFor(accountEmail: string) {
  return `salesforce:${accountKey(accountEmail)}`;
}

export async function loadSalesforce(
  accountEmail: string,
): Promise<SalesforceRegistry> {
  return (await kvGet<SalesforceRegistry>(keyFor(accountEmail))) ?? EMPTY;
}

export async function saveSalesforce(
  accountEmail: string,
  reg: SalesforceRegistry,
): Promise<void> {
  await kvSet(keyFor(accountEmail), {
    ...reg,
    syncedAt: new Date().toISOString(),
  });
}

/** Normalize a code for matching: RCD-2818, rcd_2818, RCD 2818 → RCD2818 */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Codes as they appear in real mail: study numbers, RD numbers, RFQs.
 * Deterministic — resolved before any model sees the email.
 */
export const CODE_PATTERN =
  /\b(RCD[_\s-]?\d{3,5}|LMD[_\s-]?\d{3,5}|RD\s?\d{6,7}|TGRP\d{1,3}|RFQ[\s#-]?\d{4,6}|P\d{9})\b/gi;

export type CodeLabel = { code: string; label: string };

/** Build a lookup from the registry: normalized code → display label. */
export function codeLabels(reg: SalesforceRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of reg.studies) {
    const k = normalizeCode(s.code);
    if (!k) continue;
    const bits = [s.code.toUpperCase()];
    if (s.name) bits.push(s.name);
    else if (s.account) bits.push(s.account);
    map.set(k, bits.join(" — "));
  }
  for (const o of reg.opportunities) {
    const k = normalizeCode(o.code);
    if (!k || map.has(k)) continue;
    const bits = [o.code.toUpperCase()];
    if (o.name) bits.push(o.name);
    else if (o.account) bits.push(o.account);
    map.set(k, bits.join(" — "));
  }
  return map;
}

/**
 * Parse a pasted Salesforce report (CSV or TSV). Column names are
 * matched loosely so any of the standard report layouts works.
 */
export function parseSalesforceReport(text: string): SalesforceRegistry {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return EMPTY;
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const split = (line: string) =>
    delim === "\t"
      ? line.split("\t")
      : (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) =>
          c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim(),
        );
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  const iCode = find("study code", "study number", "study", "code", "number");
  const iName = find("name", "subject", "title");
  const iAccount = find("account", "client", "sponsor");
  const iStage = find("stage", "status");

  const studies: SalesforceStudy[] = [];
  const opportunities: SalesforceOpportunity[] = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const rawCode = (iCode >= 0 ? cells[iCode] : "") || "";
    const codeMatch = rawCode.match(CODE_PATTERN)?.[0] ?? rawCode;
    const code = codeMatch?.trim();
    if (!code) continue;
    const rec = {
      code,
      name: iName >= 0 ? cells[iName]?.slice(0, 80) : undefined,
      account: iAccount >= 0 ? cells[iAccount]?.slice(0, 60) : undefined,
      status: iStage >= 0 ? cells[iStage]?.slice(0, 40) : undefined,
    };
    if (/^rfq/i.test(code)) {
      opportunities.push({ ...rec, stage: rec.status });
    } else {
      studies.push(rec);
    }
  }
  return { studies, opportunities };
}
