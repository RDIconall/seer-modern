import {
  formatAmount,
  normalizeCode,
  type SalesforceRegistry,
} from "@/lib/crm/registry";

/**
 * THE SYSTEM-OF-RECORD SEAM — Salesforce is the CEO's authority for
 * revenue, but the architecture must not hardcode it. Any role's
 * authoritative store (Salesforce, Linear/Jira, an ATS, a PSA, a legal
 * matter system) exposes the same `SystemRecord` shape: an authoritative
 * object with stage/status/value/dates that arbitrates matter identity
 * and closure. The model may explain these fields but never rewrite them.
 */

export type SystemRecord = {
  provider: string;
  type: string;
  id: string;
  title: string;
  stage?: string;
  status?: string;
  owner?: string;
  value?: number;
  startDate?: string;
  targetDate?: string;
  closedAt?: string;
  /** Codes / accounts / people this record joins to */
  entities: string[];
  url?: string;
  /** Fields the model must treat as ground truth */
  authoritativeFields: string[];
};

export type SystemOfRecordAdapter = {
  provider: string;
  /** Records keyed by normalized code, for joining to matters/emails. */
  byCode: (accountEmail: string) => Promise<Map<string, SystemRecord>>;
};

/** True when a stage/status means the work's lifecycle has ended. */
export function isClosedStatus(s?: string): boolean {
  return Boolean(s && /closed won|closed lost|\bwon\b|\blost\b|complete|terminat|cancel/i.test(s));
}

/**
 * The first adapter: the existing Salesforce registry, generalized into
 * the role-portable `SystemRecord` contract. Read-only, no new scope.
 */
export function salesforceRecords(reg: SalesforceRegistry): Map<string, SystemRecord> {
  const map = new Map<string, SystemRecord>();
  for (const o of reg.opportunities) {
    const k = normalizeCode(o.code);
    if (!k) continue;
    map.set(k, {
      provider: "salesforce",
      type: "opportunity",
      id: o.code,
      title: o.name ?? o.account ?? o.code,
      stage: o.stage,
      value: o.amount,
      targetDate: o.closeDate,
      owner: o.owner,
      entities: [o.code, o.account].filter((x): x is string => Boolean(x)),
      authoritativeFields: ["stage", "value", "targetDate", "owner"],
      ...(o.amount ? { title: `${o.name ?? o.account ?? o.code} (${formatAmount(o.amount)})` } : {}),
    });
  }
  for (const s of reg.studies) {
    const k = normalizeCode(s.code);
    if (!k || map.has(k)) continue;
    map.set(k, {
      provider: "salesforce",
      type: "study",
      id: s.code,
      title: s.name ?? s.account ?? s.code,
      status: s.status,
      entities: [s.code, s.account].filter((x): x is string => Boolean(x)),
      authoritativeFields: ["status"],
    });
  }
  return map;
}
