import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import {
  ACTION_META,
  TODAY_SECTION_ORDER,
  classifyMessage,
  type TriageAction,
} from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { loadActionMemory } from "@/lib/store/action-memory";
import { listGmailFolder, listGmailInbox } from "@/lib/mail/gmail";
import { listGraphFolder, listGraphInbox } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export const maxDuration = 60;

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

    const [history, personal, actionMemory, labels] = await Promise.all([
      getOrBuildMailHistory(
        session.email,
        session.accessToken,
        {
          listFolder: (token, folder, max) =>
            session.provider === "google"
              ? listGmailFolder(token, folder, max)
              : listGraphFolder(token, folder, max),
        },
        raw,
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
    ]);

    const decisions = await classifyInboxWithAssistant(
      session.email,
      raw.map((m) => ({
        id: m.id,
        fromEmail: m.fromEmail,
        fromName: m.fromName,
        subject: m.subject,
        snippet: m.snippet,
        labelIds: m.labelIds,
      })),
      history,
      (email) => getSenderOverride(email),
      classifyMessage,
      { personal, actionMemory, labels },
    );

    const classified: TodayEmail[] = [];
    let geminiCount = 0;
    let rulesCount = 0;
    let overrideCount = 0;
    let learnedCount = 0;
    let cachedCount = 0;
    for (const m of raw) {
      const result = decisions.get(m.id);
      if (!result) continue;
      if (result.source === "gemini") geminiCount += 1;
      else if (result.source === "rules") rulesCount += 1;
      else if (result.source === "learned") learnedCount += 1;
      else overrideCount += 1;
      if (result.cached) cachedCount += 1;
      const guide = buildActionGuideQuick(result, m.subject);
      classified.push({ ...m, guide });
    }

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
      assistant: {
        engine: "gemini-first",
        gemini: geminiCount,
        rules: rulesCount,
        override: overrideCount,
        learned: learnedCount,
        cached: cachedCount,
        needsReview: needsReview.length,
      },
      context: {
        contacts: personal.contacts.length,
        events: personal.events.length,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load inbox";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
