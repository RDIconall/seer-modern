import { gmailAction } from "@/lib/mail/gmail";
import { graphAction } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

/** Legacy parity: trash one or more messages. Body: { id } or { ids: string[] } */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as { id?: string; ids?: string[] };
    const ids = body.ids?.length
      ? body.ids
      : body.id
        ? [body.id]
        : [];
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "Provide { id } or { ids }" },
        { status: 400 },
      );
    }

    const run = session.provider === "google" ? gmailAction : graphAction;
    const batch = ids.slice(0, 25);
    await Promise.all(batch.map((id) => run(session.accessToken, id, "trash")));

    return NextResponse.json({ ok: true, deleted: batch.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
