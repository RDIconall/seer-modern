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
      items?: { id: string; action: "archive" | "trash" | "read" }[];
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

    return NextResponse.json({ ok: true, processed: batch.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
