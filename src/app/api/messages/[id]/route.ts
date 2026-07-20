import { buildActionGuideDetailed } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { extractKeyActions } from "@/lib/inbox/key-actions";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import {
  getPersonalContext,
  inviteSignals,
} from "@/lib/inbox/personal-context";
import { loadActionMemory } from "@/lib/store/action-memory";
import { loadRepliedThreads } from "@/lib/store/replied-threads";
import { getGmailMessage, listGmailFolder } from "@/lib/mail/gmail";
import { getGraphMessage, listGraphFolder } from "@/lib/mail/graph";
import { makeGmailLabelStore } from "@/lib/mail/seer-labels";
import { requireMailSession } from "@/lib/mail/session";
import { getSenderOverride } from "@/lib/store/senders";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const message =
      session.provider === "google"
        ? await getGmailMessage(session.accessToken, id)
        : await getGraphMessage(session.accessToken, id);

    const [history, personal, actionMemory, labels, replied] =
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
        loadRepliedThreads(session.email),
      ]);

    const bodyText =
      message.textBody ||
      message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    const decisions = await classifyInboxWithAssistant(
      session.email,
      [
        {
          id: message.id,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: (message.snippet || bodyText).slice(0, 600),
          labelIds: message.labelIds,
          threadId: message.threadId,
          receivedAt: message.receivedAt,
        },
      ],
      history,
      (email) => getSenderOverride(email),
      classifyMessage,
      // Single-message path: cache/label/rules only. Gemini runs on batch
      // inbox loads — never one email at a time (that burns quota fast).
      { personal, actionMemory, labels, geminiEnabled: false, replied },
    );

    const fromAssistant = decisions.get(message.id);
    const classification =
      fromAssistant ??
      ({
        ...classifyMessage(
          {
            fromEmail: message.fromEmail,
            fromName: message.fromName,
            subject: message.subject,
            snippet: message.snippet,
          },
          await getSenderOverride(message.fromEmail),
          history,
        ),
        source: "rules" as const,
      });

    const guide = await buildActionGuideDetailed(
      classification,
      message.subject,
      message.snippet,
      bodyText,
      message.fromName,
    );

    const keyActions = extractKeyActions(message.htmlBody, guide.action);

    // Calendar invite? Ship the matched event so the reader can RSVP
    const invite = inviteSignals(personal, message.subject);
    const calendarEvent =
      invite?.event.id != null
        ? {
            id: invite.event.id,
            subject: invite.event.subject,
            startsAt: invite.event.startsAt,
            myStatus: invite.event.myStatus,
          }
        : undefined;

    return NextResponse.json({
      message,
      guide,
      classification,
      keyActions,
      calendarEvent,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load message";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
