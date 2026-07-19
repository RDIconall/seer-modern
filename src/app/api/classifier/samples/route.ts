import { classifyMessage } from "@/lib/inbox/classify";
import {
  domainOf,
  type ClassifierExport,
  type ClassifierSample,
} from "@/lib/inbox/classifier-sample";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { listGmailFolder, listGmailInbox } from "@/lib/mail/gmail";
import { listGraphFolder, listGraphInbox } from "@/lib/mail/graph";
import { requireMailSession } from "@/lib/mail/session";
import { listSenderOverrides } from "@/lib/store/senders";
import { NextResponse } from "next/server";

/**
 * Export snippet-level inbox samples + current predictions for offline tuning.
 * Does not include message bodies/HTML.
 */
export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const raw =
      session.provider === "google"
        ? await listGmailInbox(session.accessToken, 60)
        : await listGraphInbox(session.accessToken, 60);

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

    const taughtSenders = await listSenderOverrides();
    const overrideMap = new Map(
      taughtSenders.map((t) => [t.email.toLowerCase(), t.action]),
    );

    const samples: ClassifierSample[] = [];
    for (const m of raw) {
      const override = overrideMap.get(m.fromEmail.toLowerCase()) ?? null;
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
      samples.push({
        id: m.id,
        fromEmail: m.fromEmail,
        fromDomain: domainOf(m.fromEmail),
        fromName: m.fromName,
        subject: m.subject,
        snippet: m.snippet.slice(0, 280),
        receivedAt: m.receivedAt,
        isUnread: m.isUnread,
        predicted: {
          action: result.action,
          confidence: result.confidence,
          reason: result.reason,
          ruleId: result.debug.ruleId,
        },
        debug: result.debug,
        expectedAction: null,
      });
    }

    const payload: ClassifierExport = {
      version: 1,
      exportedAt: new Date().toISOString(),
      accountEmail: session.email,
      provider: session.provider,
      note:
        "Snippet-level samples for Seer classifier tuning. No HTML bodies. Set expectedAction on rows you disagree with, then share the file.",
      history: {
        builtAt: history.builtAt,
        contactCount: history.contactCount,
        engagedCount: history.engagedCount,
      },
      taughtSenders,
      samples,
    };

    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition":
          'attachment; filename="seer-classifier-samples.json"',
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
