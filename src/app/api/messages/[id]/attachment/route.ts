import { getGmailAttachment } from "@/lib/mail/gmail";
import { getGraphAttachment } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { NextResponse } from "next/server";

export const maxDuration = 60;

/** Streams one attachment: /api/messages/<id>/attachment?aid=…&name=…&type=… */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const aid = searchParams.get("aid");
    if (!aid) {
      return NextResponse.json({ error: "aid required" }, { status: 400 });
    }
    const name = searchParams.get("name") ?? "attachment";
    const type = searchParams.get("type") ?? "application/octet-stream";

    const bytes =
      session.provider === "google"
        ? await getGmailAttachment(session.accessToken, id, aid)
        : await getGraphAttachment(session.accessToken, id, aid);

    // Previewable types open inline (PDF, images); the rest download
    const inline = /^(application\/pdf|image\/|text\/plain)/.test(type);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": type,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w.\- ()]/g, "_")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Attachment failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
