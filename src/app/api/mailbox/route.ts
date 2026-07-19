import { listGmailFolder, searchGmail } from "@/lib/mail/gmail";
import { listGraphFolder, searchGraph } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import type { MailFolder } from "@/lib/mail/types";
import { NextResponse } from "next/server";

const FOLDERS = new Set<MailFolder>(["inbox", "sent", "trash"]);

export async function GET(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const folderParam = (searchParams.get("folder") ?? "inbox") as MailFolder;
    const q = searchParams.get("q") ?? undefined;
    const folder = FOLDERS.has(folderParam) ? folderParam : "inbox";

    let items;
    if (session.provider === "google") {
      items = q?.trim()
        ? await searchGmail(session.accessToken, q)
        : await listGmailFolder(session.accessToken, folder, 40, q);
    } else {
      items = q?.trim() && !searchParams.get("folder")
        ? await searchGraph(session.accessToken, q)
        : await listGraphFolder(session.accessToken, folder, 40, q);
    }

    return NextResponse.json({
      accountEmail: session.email,
      provider: session.provider,
      folder: q?.trim() ? "search" : folder,
      q: q ?? null,
      fetchedAt: new Date().toISOString(),
      items,
      count: items.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load mailbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
