import { requireMailSession } from "@/lib/mail/session";
import { loadLedger } from "@/lib/store/triage-ledger";
import { NextResponse } from "next/server";

/** The Cleaned ledger — everything Triage did, most recent first. */
export async function GET() {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const ledger = await loadLedger(session.email);
  return NextResponse.json({ entries: ledger.entries.slice(0, 200) });
}
