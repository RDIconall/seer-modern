import { gmailAction } from "@/lib/mail/gmail";
import { graphAction } from "@/lib/mail/graph";
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
      items?: {
        id: string;
        action: "archive" | "trash" | "read";
        fromEmail?: string;
      }[];
    };
    const items = body.items ?? [];
    if (items.length === 0) {
      return NextResponse.json({ error: "No items" }, { status: 400 });
    }

    const run = session.provider === "google" ? gmailAction : graphAction;
    const batch = items.slice(0, 15);
    await Promise.all(
      batch.map((item) => run(session.accessToken, item.id, item.action)),
    );

    // Implicit teaching from bulk sweeps too (sequential: shared file)
    for (const item of batch) {
      if (item.fromEmail && (item.action === "archive" || item.action === "trash")) {
        await recordSenderAction(session.email, item.fromEmail, item.action).catch(
          () => {},
        );
      }
    }

    return NextResponse.json({ ok: true, processed: batch.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
