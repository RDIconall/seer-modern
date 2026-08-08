import { gmailAction, gmailThreadAction } from "@/lib/mail/gmail";
import { graphAction, graphThreadAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { recordSenderAction } from "@/lib/store/action-memory";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      id?: string;
      threadId?: string;
      action?: "archive" | "trash" | "read";
      fromEmail?: string;
    };
    if (!body.id || !body.action) {
      return NextResponse.json(
        { error: "Provide { id, action: archive|trash|read }" },
        { status: 400 },
      );
    }

    // Threads, not messages: archive/trash clears the WHOLE
    // conversation, exactly like Gmail's own archive button.
    if (body.threadId) {
      if (session.provider === "google") {
        await gmailThreadAction(session.accessToken, body.threadId, body.action);
      } else {
        await graphThreadAction(session.accessToken, body.threadId, body.action);
      }
    } else if (session.provider === "google") {
      await gmailAction(session.accessToken, body.id, body.action);
    } else {
      await graphAction(session.accessToken, body.id, body.action);
    }

    // Implicit teaching: your actions predict your next action
    if (body.fromEmail && (body.action === "archive" || body.action === "trash")) {
      await recordSenderAction(session.email, body.fromEmail, body.action).catch(
        () => {},
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
