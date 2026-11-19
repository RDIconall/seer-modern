import { isTriageAction } from "@/lib/inbox/classify";
import { setSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";
import { requireMailSession } from "@/lib/mail/session";

export async function POST(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    fromEmail?: unknown;
    action?: unknown;
  } | null;
  const fromEmail =
    typeof body?.fromEmail === "string" ? body.fromEmail.trim() : "";
  const action = body?.action;
  if (!fromEmail || !isTriageAction(action)) {
    return NextResponse.json(
      { error: "Provide { fromEmail, action } with a known triage action" },
      { status: 400 },
    );
  }

  await setSenderOverride(fromEmail, action, session.email);
  return NextResponse.json({ ok: true });
}
