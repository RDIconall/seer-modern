/**
 * The CRM registry's SHAPE and pure helpers — no storage, no fs, so the
 * client can format an amount without dragging Redis into the bundle.
 */

export type SalesforceStudy = {
  /** RCD_2818, RD007704, LMD_1234 — the code that appears in mail */
  code: string;
  name?: string;
  account?: string;
  status?: string;
  phase?: string;
};

export type SalesforceOpportunity = {
  /** RFQ or opportunity number as it appears in mail */
  code: string;
  name?: string;
  account?: string;
  stage?: string;
  /** Estimated value — what this thread is actually worth */
  amount?: number;
  closeDate?: string;
  owner?: string;
};

/** A site and its investigator — the people running awarded work */
export type SalesforceSite = {
  name: string;
  investigator?: string;
  city?: string;
  studyCode?: string;
  status?: string;
};

export type SalesforceRegistry = {
  studies: SalesforceStudy[];
  opportunities: SalesforceOpportunity[];
  sites?: SalesforceSite[];
  /** "api" when pulled live, "report" when pasted */
  source?: "api" | "report";
  /** Which discovered objects the live pull used */
  studyObject?: string;
  siteObject?: string;
  syncedAt?: string;
};

/** $88,180 → "$88k"; small values keep their precision */
export function formatAmount(amount: number): string {
  if (amount >= 1_000_000)
    return `$${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
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
    if (o.amount) bits.push(formatAmount(o.amount));
    map.set(k, bits.join(" — "));
  }
  return map;
}

/** normalized code → opportunity, for attaching value to a matter */
export function opportunityIndex(
  reg: SalesforceRegistry,
): Map<string, SalesforceOpportunity> {
  const map = new Map<string, SalesforceOpportunity>();
  for (const o of reg.opportunities) {
    const k = normalizeCode(o.code);
    if (k) map.set(k, o);
  }
  return map;
}

const ADDRESS = /[^\s<>()[\]",;:@]+@[^\s<>()[\]",;:@]+\.[^\s<>()[\]",;:@]+/g;
const BARE_ADDRESS = /^[^\s<>()[\]",;:@]+@[^\s<>()[\]",;:@]+\.[^\s<>()[\]",;:@]+$/;

/** Every email address written into a CRM field, lowercased. */
function addressesIn(value?: string): string[] {
  return (value?.match(ADDRESS) ?? []).map((a) => a.toLowerCase());
}

/**
 * The part of the registry one sender is tied to: opportunities whose owner
 * field holds that address, and studies with a site whose investigator field
 * holds it. A code in a subject or preview is something anyone can type, so
 * registry facts attach to mail only through this slice. Matching is on the
 * address the CRM holds — never the display name, which the sender chooses.
 */
export function senderRegistry(
  reg: SalesforceRegistry,
): (fromEmail: string) => SalesforceRegistry {
  const oppsBy = new Map<string, SalesforceOpportunity[]>();
  for (const o of reg.opportunities) {
    for (const a of new Set(addressesIn(o.owner))) {
      oppsBy.set(a, [...(oppsBy.get(a) ?? []), o]);
    }
  }
  const studiesBy = new Map<string, Set<string>>();
  for (const site of reg.sites ?? []) {
    const k = site.studyCode ? normalizeCode(site.studyCode) : "";
    if (!k) continue;
    for (const a of addressesIn(site.investigator)) {
      studiesBy.set(a, (studiesBy.get(a) ?? new Set()).add(k));
    }
  }
  const cache = new Map<string, SalesforceRegistry>();
  return (fromEmail) => {
    const sender = fromEmail.trim().toLowerCase();
    const hit = cache.get(sender);
    if (hit) return hit;
    const codes = BARE_ADDRESS.test(sender)
      ? (studiesBy.get(sender) ?? new Set<string>())
      : new Set<string>();
    const tied: SalesforceRegistry = {
      studies: reg.studies.filter((s) => codes.has(normalizeCode(s.code))),
      opportunities: BARE_ADDRESS.test(sender)
        ? (oppsBy.get(sender) ?? [])
        : [],
      sites: (reg.sites ?? []).filter(
        (s) => s.studyCode && codes.has(normalizeCode(s.studyCode)),
      ),
      source: reg.source,
      syncedAt: reg.syncedAt,
    };
    cache.set(sender, tied);
    return tied;
  };
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
  if (lines.length < 2) return { studies: [], opportunities: [], sites: [] };
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
  return { studies, opportunities, sites: [] };
}
