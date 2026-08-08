import { requireMailSession } from "@/lib/mail/session";
import {
  loadSalesforce,
  parseSalesforceReport,
  saveSalesforce,
  type SalesforceRegistry,
} from "@/lib/store/salesforce";
import { NextResponse } from "next/server";

/**
 * The live registry of active studies and open opportunities. Atlas uses
 * it to name the branches inside each function, so "operations — studies"
 * splits by real study instead of becoming one heap.
 *
 * POST accepts either a pasted Salesforce report (CSV/TSV) or explicit
 * JSON. A direct org connection can be added later without changing the
 * consumers — they only read the registry.
 */
export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const registry = await loadSalesforce(session.email);
  return NextResponse.json({
    registry,
    counts: {
      studies: registry.studies.length,
      opportunities: registry.opportunities.length,
    },
  });
}

export async function POST(req: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    report?: string;
    registry?: SalesforceRegistry;
  };

  const registry = body.registry ?? parseSalesforceReport(body.report ?? "");
  if (registry.studies.length === 0 && registry.opportunities.length === 0) {
    return NextResponse.json(
      { error: "No study or opportunity codes found in that report" },
      { status: 400 },
    );
  }
  await saveSalesforce(session.email, registry);
  return NextResponse.json({
    ok: true,
    counts: {
      studies: registry.studies.length,
      opportunities: registry.opportunities.length,
    },
  });
}
