import { gmailAction } from "@/lib/mail/gmail";
import { graphAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      id?: string;
      action?: "archive" | "trash" | "read";
    };
    if (!body.id || !body.action) {
      return NextResponse.json(
        { error: "Provide { id, action: archive|trash|read }" },
        { status: 400 },
      );
    }

    if (session.provider === "google") {
      await gmailAction(session.accessToken, body.id, body.action);
    } else {
      await graphAction(session.accessToken, body.id, body.action);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
