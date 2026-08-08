import { syncSalesforce } from "@/lib/crm/salesforce-sync";
import { requireMailSession } from "@/lib/mail/session";
import {
  loadSalesforce,
  parseSalesforceReport,
  saveSalesforce,
  type SalesforceRegistry,
} from "@/lib/store/salesforce";
import {
  clearConnection,
  DEFAULT_LOGIN_URL,
  loadApp,
  loadConnection,
  resolveCreds,
  saveApp,
} from "@/lib/store/salesforce-auth";
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
  const [app, conn, resolved] = await Promise.all([
    loadApp(session.email),
    loadConnection(session.email),
    resolveCreds(session.email),
  ]);
  const value = registry.opportunities.reduce(
    (sum, o) => sum + (o.amount ?? 0),
    0,
  );
  return NextResponse.json({
    configured: Boolean(resolved),
    flow: resolved?.via ?? null,
    // Can the user just click Connect, or must an app be registered first?
    canConnect: Boolean(app),
    appSource: app?.source ?? null,
    connection: conn
      ? {
          username: conn.username,
          displayName: conn.displayName,
          instanceUrl: conn.instanceUrl,
          connectedAt: conn.connectedAt,
        }
      : null,
    loginUrl: app?.loginUrl ?? resolved?.creds.loginUrl,
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
    action?: "sync" | "clear" | "app" | "disconnect";
    report?: string;
    registry?: SalesforceRegistry;
    clientId?: string;
    clientSecret?: string;
    sandbox?: boolean;
  };

  // Register the Connected App from the UI, so nothing has to be
  // deployed to change it. The consumer key is public under PKCE.
  if (body.action === "app") {
    const clientId = body.clientId?.trim();
    if (!clientId) {
      return NextResponse.json(
        { error: "Paste the Connected App's Consumer Key" },
        { status: 400 },
      );
    }
    await saveApp(session.email, {
      clientId,
      ...(body.clientSecret?.trim()
        ? { clientSecret: body.clientSecret.trim() }
        : {}),
      loginUrl: body.sandbox
        ? "https://test.salesforce.com"
        : DEFAULT_LOGIN_URL,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "disconnect") {
    await clearConnection(session.email);
    return NextResponse.json({ ok: true, disconnected: true });
  }

  if (body.action === "clear") {
    await saveSalesforce(session.email, {
      studies: [],
      opportunities: [],
      sites: [],
    });
    return NextResponse.json({ ok: true, cleared: true });
  }

  if (body.action === "sync") {
    const resolved = await resolveCreds(session.email);
    if (!resolved) {
      return NextResponse.json(
        {
          error:
            "Salesforce isn't connected yet. Add a Connected App's Consumer Key below, then click Log in with Salesforce.",
        },
        { status: 400 },
      );
    }
    try {
      const report = await syncSalesforce(session.email, resolved.creds);
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
