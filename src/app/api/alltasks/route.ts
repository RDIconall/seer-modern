import { buildActionGuideQuick } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import type { IphoneTask } from "@/lib/api-parity/iphone-task-types";
import { LEGACY_SESSION_COOKIE } from "@/lib/future-ios";
import { listGmailInbox } from "@/lib/mail/gmail";
import { listGraphInbox } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

/**
 * Legacy Seer GET /api/alltasks — card deck as IphoneTask[].
 * Maps modern inbox + triage classification into the old card shape.
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

    const tasks: IphoneTask[] = [];
    for (const m of raw) {
      const override = await getSenderOverride(m.fromEmail);
      const classification = classifyMessage(
        {
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          snippet: m.snippet,
        },
        override,
      );
      const guide = buildActionGuideQuick(classification, m.subject);
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
