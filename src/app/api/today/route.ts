import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import {
  ACTION_META,
  TODAY_SECTION_ORDER,
  classifyMessage,
  type TriageAction,
} from "@/lib/inbox/classify";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { listGmailFolder, listGmailInbox } from "@/lib/mail/gmail";
import { listGraphFolder, listGraphInbox } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export type TodayEmail = {
  id: string;
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  guide: ReturnType<typeof buildActionGuideQuick>;
};

export type TodaySection = {
  action: TriageAction;
  label: string;
  color: string;
  bulkLabel: string;
  items: TodayEmail[];
};

export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const raw =
      session.provider === "google"
        ? await listGmailInbox(session.accessToken, 50)
        : await listGraphInbox(session.accessToken, 50);

    const history = await getOrBuildMailHistory(
      session.email,
      session.accessToken,
      {
        listFolder: (token, folder, max) =>
          session.provider === "google"
            ? listGmailFolder(token, folder, max)
            : listGraphFolder(token, folder, max),
      },
      raw,
    );

    const classified: TodayEmail[] = [];
    for (const m of raw) {
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
      classified.push({ ...m, guide });
    }

    // Only true "needs_review" actions go in the review bucket.
    // LOW confidence still keeps its action so mail isn't left uncategorized.
    const needsReview = classified.filter(
      (e) => e.guide.action === "needs_review",
    );
    const processed = classified.filter(
      (e) => e.guide.action !== "needs_review",
    );

    const byAction = new Map<TriageAction, TodayEmail[]>();
    for (const e of processed) {
      const list = byAction.get(e.guide.action) ?? [];
      list.push(e);
      byAction.set(e.guide.action, list);
    }

    const sections: TodaySection[] = TODAY_SECTION_ORDER.filter(
      (a) => a !== "needs_review" && (byAction.get(a)?.length ?? 0) > 0,
    ).map((action) => ({
      action,
      label: ACTION_META[action].label,
      color: ACTION_META[action].color,
      bulkLabel: ACTION_META[action].bulkLabel,
      items: byAction.get(action) ?? [],
    }));

    const inbox = [...classified].sort(
      (a, b) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );

    return NextResponse.json({
      accountEmail: session.email,
      provider: session.provider,
      fetchedAt: new Date().toISOString(),
      inbox,
      needsReview,
      sections,
      count: classified.length,
      history: {
        builtAt: history.builtAt,
        contactCount: history.contactCount,
        engagedCount: history.engagedCount,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load inbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
