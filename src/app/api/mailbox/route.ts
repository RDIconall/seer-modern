import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import type { EmailItem } from "@/lib/inbox/types";
import { listGmailFolder, searchGmail } from "@/lib/mail/gmail";
import { listGraphFolder, searchGraph } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import type { MailFolder, MailMessageListItem } from "@/lib/mail/types";
import { getSenderOverride } from "@/lib/store/senders";
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

    let items: MailMessageListItem[];
    if (session.provider === "google") {
      items = q?.trim()
        ? await searchGmail(session.accessToken, q)
        : await listGmailFolder(session.accessToken, folder, 40, q);
    } else {
      items =
        q?.trim() && !searchParams.get("folder")
          ? await searchGraph(session.accessToken, q)
          : await listGraphFolder(session.accessToken, folder, 40, q);
    }

    // Classify inbox (and search) so each row can show why it landed in a bucket
    const shouldClassify = folder === "inbox" || Boolean(q?.trim());
    let annotated: EmailItem[] = items;
    if (shouldClassify) {
      const history = await getOrBuildMailHistory(
        session.email,
        session.accessToken,
        {
          listFolder: (token, f, max) =>
            session.provider === "google"
              ? listGmailFolder(token, f, max)
              : listGraphFolder(token, f, max),
        },
        folder === "inbox" && !q?.trim() ? items : undefined,
      );

      annotated = [];
      for (const m of items) {
        const override = await getSenderOverride(m.fromEmail);
        const result = classifyMessage(
          {
            fromEmail: m.fromEmail,
            fromName: m.fromName,
            subject: m.subject,
            snippet: m.snippet,
          },
          override,
          history,
        );
        const guide = buildActionGuideQuick(result, m.subject);
        annotated.push({ ...m, guide });
      }
    }

    return NextResponse.json({
      accountEmail: session.email,
      provider: session.provider,
      folder: q?.trim() ? "search" : folder,
      q: q ?? null,
      fetchedAt: new Date().toISOString(),
      items: annotated,
      count: annotated.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load mailbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
