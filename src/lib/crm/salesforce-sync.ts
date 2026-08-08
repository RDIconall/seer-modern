import {
  authenticate,
  describeObject,
  listObjects,
  pickField,
  soql,
  type SalesforceAuth,
  type SalesforceCreds,
} from "@/lib/crm/salesforce-api";
import {
  saveSalesforce,
  type SalesforceOpportunity,
  type SalesforceRegistry,
  type SalesforceSite,
  type SalesforceStudy,
} from "@/lib/store/salesforce";

/**
 * Pull the live business into Seer: open opportunities with amounts,
 * active studies, and the sites/investigators running them.
 *
 * Every org models studies differently, so nothing is hardcoded. We ask
 * the org what objects exist, score the candidates by name, then read
 * whichever fields that object actually has.
 */

export type SyncReport = {
  opportunities: number;
  studies: number;
  sites: number;
  studyObject?: string;
  siteObject?: string;
  notes: string[];
};

const STUDY_HINT = /stud|protocol|trial|assay|project/i;
const SITE_HINT = /site|investigator|physician|doctor|center|centre|clinic/i;

function scoreName(name: string, hint: RegExp): number {
  if (!hint.test(name)) return 0;
  let score = 10;
  // A dedicated custom object beats a junction/history/share table
  if (/(share|history|feed|tag|changeevent|__mdt)$/i.test(name)) score -= 20;
  if (/^(rdi|seer)?_?stud(y|ies)__c$/i.test(name)) score += 6;
  if (name.endsWith("__c")) score += 3;
  if (/junction|link|assignment|member/i.test(name)) score -= 4;
  return score;
}

async function bestObject(
  auth: SalesforceAuth,
  hint: RegExp,
): Promise<string | undefined> {
  const objects = await listObjects(auth);
  const ranked = objects
    .map((o) => ({
      name: o.name,
      score: Math.max(scoreName(o.name, hint), scoreName(o.label, hint)),
    }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.name;
}

/** Codes look like RCD_2818 / RD007704 — find the field that holds them. */
const CODE_FIELD = [
  /study.*(code|number|id)/i,
  /(code|number)$/i,
  /^name$/i,
];

export async function syncSalesforce(
  accountEmail: string,
  creds: SalesforceCreds,
): Promise<SyncReport> {
  const auth = await authenticate(creds);
  const notes: string[] = [];

  // ---- Opportunities: standard object, so the fields are known ----
  let opportunities: SalesforceOpportunity[] = [];
  try {
    type OppRow = {
      Name?: string;
      StageName?: string;
      Amount?: number;
      CloseDate?: string;
      Account?: { Name?: string } | null;
      Owner?: { Name?: string } | null;
    };
    const rows = await soql<OppRow>(
      auth,
      `SELECT Name, StageName, Amount, CloseDate, Account.Name, Owner.Name
       FROM Opportunity
       WHERE IsClosed = false
       ORDER BY Amount DESC NULLS LAST
       LIMIT 300`,
    );
    opportunities = rows.map((r) => ({
      // The code users type in email is usually inside the name
      code: r.Name?.match(/\b[A-Z]{2,4}[_\s-]?\d{3,7}\b/)?.[0] ?? r.Name ?? "",
      name: r.Name?.slice(0, 90),
      account: r.Account?.Name?.slice(0, 60),
      stage: r.StageName?.slice(0, 40),
      amount: typeof r.Amount === "number" ? r.Amount : undefined,
      closeDate: r.CloseDate ?? undefined,
      owner: r.Owner?.Name?.slice(0, 60),
    }));
  } catch (e) {
    notes.push(
      `Opportunities: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`,
    );
  }

  // ---- Studies: custom object, discovered ----
  let studies: SalesforceStudy[] = [];
  const studyObject = await bestObject(auth, STUDY_HINT).catch(() => undefined);
  if (studyObject) {
    const meta = await describeObject(auth, studyObject);
    if (meta) {
      const fCode = pickField(meta, CODE_FIELD) ?? "Name";
      const fName = pickField(meta, [/title/i, /^name$/i, /description/i]);
      const fStatus = pickField(meta, [/status/i, /stage/i, /state/i]);
      const fSponsor = pickField(meta, [/sponsor/i, /account/i, /client/i]);
      const fPhase = pickField(meta, [/phase/i]);
      const fields = [...new Set([fCode, fName, fStatus, fSponsor, fPhase])]
        .filter((f): f is string => Boolean(f))
        .join(", ");
      try {
        const rows = await soql<Record<string, unknown>>(
          auth,
          `SELECT ${fields} FROM ${studyObject} ORDER BY LastModifiedDate DESC LIMIT 500`,
        );
        const str = (v: unknown) =>
          typeof v === "string" ? v : v == null ? undefined : String(v);
        studies = rows
          .map((r) => ({
            code: str(r[fCode]) ?? "",
            name: fName ? str(r[fName])?.slice(0, 90) : undefined,
            account: fSponsor ? str(r[fSponsor])?.slice(0, 60) : undefined,
            status: fStatus ? str(r[fStatus])?.slice(0, 40) : undefined,
            phase: fPhase ? str(r[fPhase])?.slice(0, 30) : undefined,
          }))
          .filter((s) => s.code);
      } catch (e) {
        notes.push(
          `${studyObject}: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`,
        );
      }
    }
  } else {
    notes.push("No study-like object found — check the integration user's access");
  }

  // ---- Sites / investigators: custom object, discovered ----
  let sites: SalesforceSite[] = [];
  const siteObject = await bestObject(auth, SITE_HINT).catch(() => undefined);
  if (siteObject) {
    const meta = await describeObject(auth, siteObject);
    if (meta) {
      const fName = pickField(meta, [/site.*name/i, /^name$/i]) ?? "Name";
      const fPi = pickField(meta, [
        /investigator/i,
        /physician/i,
        /doctor/i,
        /^contact/i,
      ]);
      const fCity = pickField(meta, [/city/i, /location/i, /state/i]);
      const fStudy = pickField(meta, [/stud/i, /protocol/i]);
      const fStatus = pickField(meta, [/status/i, /stage/i]);
      const fields = [...new Set([fName, fPi, fCity, fStudy, fStatus])]
        .filter((f): f is string => Boolean(f))
        .join(", ");
      try {
        const rows = await soql<Record<string, unknown>>(
          auth,
          `SELECT ${fields} FROM ${siteObject} ORDER BY LastModifiedDate DESC LIMIT 500`,
        );
        const str = (v: unknown) =>
          typeof v === "string" ? v : v == null ? undefined : String(v);
        sites = rows
          .map((r) => ({
            name: str(r[fName])?.slice(0, 80) ?? "",
            investigator: fPi ? str(r[fPi])?.slice(0, 60) : undefined,
            city: fCity ? str(r[fCity])?.slice(0, 40) : undefined,
            studyCode: fStudy ? str(r[fStudy])?.slice(0, 40) : undefined,
            status: fStatus ? str(r[fStatus])?.slice(0, 40) : undefined,
          }))
          .filter((s) => s.name);
      } catch (e) {
        notes.push(
          `${siteObject}: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`,
        );
      }
    }
  }

  const registry: SalesforceRegistry = {
    studies,
    opportunities,
    sites,
    source: "api",
    studyObject,
    siteObject,
  };
  await saveSalesforce(accountEmail, registry);

  return {
    opportunities: opportunities.length,
    studies: studies.length,
    sites: sites.length,
    studyObject,
    siteObject,
    notes,
  };
}
