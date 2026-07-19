import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { loadActionMemory } from "@/lib/store/action-memory";
import { loadUserProfile } from "@/lib/store/user-profile";
import type { IphoneTask } from "@/lib/api-parity/iphone-task-types";
import { LEGACY_SESSION_COOKIE } from "@/lib/future-ios";
import { listGmailFolder, listGmailInbox } from "@/lib/mail/gmail";
import { listGraphFolder, listGraphInbox } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

/**
 * Legacy Seer GET /api/alltasks — card deck as IphoneTask[].
 * Maps modern inbox + Gemini-first triage into the old card shape.
 */
export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw =
      session.provider === "google"
        ? await listGmailInbox(session.accessToken, 30)
        : await listGraphInbox(session.accessToken, 30);

    const [history, personal, actionMemory, labels, profile] =
      await Promise.all([
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
        loadUserProfile(session.email),
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
      { personal, actionMemory, labels, profile },
    );

    const tasks: IphoneTask[] = [];
    for (const m of raw) {
      const classification = decisions.get(m.id);
      if (!classification) continue;
      const guide = buildActionGuideQuick(classification, m.subject, m.fromName);
      tasks.push({
        id: m.id,
        taskType: guide.action,
        name: guide.label,
        deferred: false,
        score:
          guide.confidence === "HIGH"
            ? 0.9
            : guide.confidence === "MED"
              ? 0.6
              : 0.3,
        sentence: guide.instruction,
        email: {
          id: m.id,
          link: "",
          time: new Date(m.receivedAt).getTime(),
          subject: m.subject,
          text: m.snippet,
          html: "",
          attachments: [],
          from: {
            email: m.fromEmail,
            name: m.fromName,
            relationship: "unknown",
            sent: 0,
            received: 0,
          },
          to: [],
          cc: [],
          bcc: [],
        },
        sentenceOffsets: [],
      });
    }

    const res = NextResponse.json(tasks);
    res.headers.set("X-Seer-Legacy-Cookie-Ref", LEGACY_SESSION_COOKIE);
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load tasks";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
