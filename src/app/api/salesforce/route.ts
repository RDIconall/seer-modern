import { credsFromEnv } from "@/lib/crm/salesforce-api";
import { syncSalesforce } from "@/lib/crm/salesforce-sync";
import { requireMailSession } from "@/lib/mail/session";
import {
  loadSalesforce,
  parseSalesforceReport,
  saveSalesforce,
  type SalesforceRegistry,
} from "@/lib/store/salesforce";
import { NextResponse } from "next/server";

export const maxDuration = 120;

/**
 * The live registry of opportunities, studies, sites and investigators.
 * Atlas uses it to name branches, weight matters by real money, and
 * recognize the people running awarded work.
 *
 * POST { action: "sync" }   → pull live from the Salesforce API
 * POST { report: "<csv>" }  → fall back to a pasted report
 */
export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const registry = await loadSalesforce(session.email);
  const creds = credsFromEnv();
  const value = registry.opportunities.reduce(
    (sum, o) => sum + (o.amount ?? 0),
    0,
  );
  return NextResponse.json({
    configured: Boolean(creds),
    flow: creds?.privateKey
      ? "jwt-bearer"
      : creds?.refreshToken
        ? "refresh-token"
        : creds?.clientSecret
          ? "client-credentials"
          : null,
    loginUrl: creds?.loginUrl,
    counts: {
      studies: registry.studies.length,
      opportunities: registry.opportunities.length,
      sites: registry.sites?.length ?? 0,
    },
    pipelineValue: value || undefined,
    source: registry.source,
    studyObject: registry.studyObject,
    siteObject: registry.siteObject,
    syncedAt: registry.syncedAt,
  });
}

export async function POST(req: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: "sync" | "clear";
    report?: string;
    registry?: SalesforceRegistry;
  };

  if (body.action === "clear") {
    await saveSalesforce(session.email, {
      studies: [],
      opportunities: [],
      sites: [],
    });
    return NextResponse.json({ ok: true, cleared: true });
  }

  if (body.action === "sync") {
    const creds = credsFromEnv();
    if (!creds) {
      return NextResponse.json(
        {
          error:
            "Salesforce is not configured. Add SALESFORCE_CLIENT_ID plus either SALESFORCE_USERNAME + SALESFORCE_PRIVATE_KEY (JWT bearer) or SALESFORCE_REFRESH_TOKEN, then sync again.",
        },
        { status: 400 },
      );
    }
    try {
      const report = await syncSalesforce(session.email, creds);
      return NextResponse.json({ ok: true, ...report });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Salesforce sync failed" },
        { status: 502 },
      );
    }
  }

  const registry = body.registry ?? parseSalesforceReport(body.report ?? "");
  if (registry.studies.length === 0 && registry.opportunities.length === 0) {
    return NextResponse.json(
      { error: "No study or opportunity codes found in that report" },
      { status: 400 },
    );
  }
  await saveSalesforce(session.email, { ...registry, source: "report" });
  return NextResponse.json({
    ok: true,
    counts: {
      studies: registry.studies.length,
      opportunities: registry.opportunities.length,
    },
  });
}
