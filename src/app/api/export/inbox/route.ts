import { loadBrief } from "@/lib/inbox/matters";
import { buildExportRows, toCsv } from "@/lib/inbox/export";
import { requireMailSession } from "@/lib/mail/session";
import { loadUnderstanding } from "@/lib/store/understanding-store";
import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function GET(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const brief = await loadBrief(session.email);
  if (!brief) {
    return NextResponse.json({ error: "Brief not ready" }, { status: 409 });
  }
  const understanding = await loadUnderstanding(session.email).catch(() => ({}));
  const rows = buildExportRows(brief, understanding);

  if (new URL(request.url).searchParams.get("format") === "json") {
    return NextResponse.json({
      builtAt: brief.builtAt,
      accounting: brief.accounting,
      rows,
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="seer-inbox-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
