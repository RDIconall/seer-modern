import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { loadActionMemory } from "@/lib/store/action-memory";
import { loadRepliedThreads } from "@/lib/store/replied-threads";
import { loadUserProfile } from "@/lib/store/user-profile";
import type { EmailItem } from "@/lib/inbox/types";
import { listGmailFolder, searchGmail } from "@/lib/mail/gmail";
import { listGraphFolder, searchGraph } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import type { MailFolder, MailMessageListItem } from "@/lib/mail/types";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const FOLDERS = new Set<MailFolder>(["inbox", "sent", "trash"]);

/** Whole-inbox scan, matching /api/today — inbox zero needs it all. */
const SCAN = Math.max(
  100,
  Math.min(1000, Number(process.env.SEER_INBOX_SCAN ?? "1000") || 1000),
);

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

    const depth = folder === "inbox" ? SCAN : 100;
    let items: MailMessageListItem[];
    if (session.provider === "google") {
      items = q?.trim()
        ? await searchGmail(session.accessToken, q, 60)
        : await listGmailFolder(session.accessToken, folder, depth, q);
    } else {
      items =
        q?.trim() && !searchParams.get("folder")
          ? await searchGraph(session.accessToken, q, 60)
          : await listGraphFolder(session.accessToken, folder, depth, q);
    }

    const shouldClassify = folder === "inbox" || Boolean(q?.trim());
    let annotated: EmailItem[] = items;
    let assistant:
      | {
          gemini: number;
          rules: number;
          override: number;
          learned: number;
          cached: number;
        }
      | undefined;

    if (shouldClassify) {
      const [history, personal, actionMemory, labels, profile, replied] =
        await Promise.all([
          getOrBuildMailHistory(
            session.email,
            session.accessToken,
            {
              listFolder: (token, f, max) =>
                session.provider === "google"
                  ? listGmailFolder(token, f, max)
                  : listGraphFolder(token, f, max),
            },
            folder === "inbox" && !q?.trim() ? items : undefined,
          ),
          getPersonalContext({
            accountEmail: session.email,
            accessToken: session.accessToken,
            provider: session.provider,
          }),
          loadActionMemory(session.email),
          session.provider === "google"
            ? makeGmailLabelStore(session.accessToken, session.email)
            : Promise.resolve(null),
          loadUserProfile(session.email),
          loadRepliedThreads(session.email),
        ]);

      const decisions = await classifyInboxWithAssistant(
        session.email,
        items.map((m) => ({
          id: m.id,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          snippet: m.snippet,
          labelIds: m.labelIds,
          threadId: m.threadId,
          receivedAt: m.receivedAt,
        })),
        history,
        (email) => getSenderOverride(email),
        classifyMessage,
        { personal, actionMemory, labels, profile, replied },
      );

      annotated = [];
      let gemini = 0;
      let rules = 0;
      let override = 0;
      let learned = 0;
      let cached = 0;
      for (const m of items) {
        const result = decisions.get(m.id);
        if (!result) {
          annotated.push(m);
          continue;
        }
        if (result.source === "gemini") gemini += 1;
        else if (result.source === "rules") rules += 1;
        else if (result.source === "learned") learned += 1;
        else override += 1;
        if (result.cached) cached += 1;
        annotated.push({
          ...m,
          guide: buildActionGuideQuick(result, m.subject, m.fromName),
        });
      }
      assistant = { gemini, rules, override, learned, cached };
    }

    return NextResponse.json({
      accountEmail: session.email,
      provider: session.provider,
      folder: q?.trim() ? "search" : folder,
      q: q ?? null,
      fetchedAt: new Date().toISOString(),
      items: annotated,
      count: annotated.length,
      assistant,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load mailbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
