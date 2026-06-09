import type { TriageAction } from "@/lib/inbox/classify";
import { setSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";
import { requireMailSession } from "@/lib/mail/session";

export async function POST(request: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as {
    fromEmail?: string;
    action?: TriageAction;
  };
  if (!body.fromEmail || !body.action) {
    return NextResponse.json(
      { error: "Provide { fromEmail, action }" },
      { status: 400 },
    );
  }

  await setSenderOverride(body.fromEmail, body.action);
  return NextResponse.json({ ok: true });
}
