import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import {
  ACTION_META,
  TODAY_SECTION_ORDER,
  classifyMessage,
  type TriageAction,
} from "@/lib/inbox/classify";
import { llmClassifyBatch } from "@/lib/inbox/llm-classify";
import { listGmailInbox } from "@/lib/mail/gmail";
import { listGraphInbox } from "@/lib/mail/graph";
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
        ? await listGmailInbox(session.accessToken)
        : await listGraphInbox(session.accessToken);

    // Sender overrides taught by the user always win; everything else goes
    // to the LLM in one batch, with rule-based classification as fallback.
    const overrides = new Map<string, Awaited<ReturnType<typeof getSenderOverride>>>();
    for (const m of raw) {
      overrides.set(m.id, await getSenderOverride(m.fromEmail));
    }

    const llmResults = await llmClassifyBatch(
      raw
        .filter((m) => !overrides.get(m.id))
        .map((m) => ({
          id: m.id,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          snippet: m.snippet,
        })),
    );

    const classified: TodayEmail[] = raw.map((m) => {
      const result =
        llmResults.get(m.id) ??
        classifyMessage(
          {
            fromEmail: m.fromEmail,
            fromName: m.fromName,
            subject: m.subject,
            snippet: m.snippet,
          },
          overrides.get(m.id),
        );
      const guide = buildActionGuideQuick(result, m.subject);
      return { ...m, guide };
    });

    const needsReview = classified.filter(
      (e) =>
        e.guide.confidence === "LOW" ||
        e.guide.confidence === "NEW" ||
        e.guide.action === "needs_review",
    );
    const processed = classified.filter(
      (e) =>
        e.guide.confidence !== "LOW" &&
        e.guide.confidence !== "NEW" &&
        e.guide.action !== "needs_review",
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

    return NextResponse.json({
      accountEmail: session.email,
      provider: session.provider,
      fetchedAt: new Date().toISOString(),
      needsReview,
      sections,
      count: classified.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load inbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
