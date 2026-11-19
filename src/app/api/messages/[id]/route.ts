import { buildActionGuideDetailed } from "@/lib/inbox/action-guide";
import { classifyMessage } from "@/lib/inbox/classify";
import { extractKeyActions } from "@/lib/inbox/key-actions";
import { classifyInboxWithAssistant } from "@/lib/inbox/gemini-triage";
import { getOrBuildMailHistory } from "@/lib/inbox/mail-history-store";
import { resolveInviteEvent } from "@/lib/inbox/invite-event";
import { getPersonalContext } from "@/lib/inbox/personal-context";
import { loadActionMemory } from "@/lib/store/action-memory";
import { loadRepliedThreads } from "@/lib/store/replied-threads";
import {
  getGmailMessage,
  getGmailThreadMessages,
  getGmailThreadLast,
  listGmailFolder,
  searchGmail,
} from "@/lib/mail/gmail";
import {
  getGraphConversationMessages,
  getGraphMessage,
  listGraphFolder,
} from "@/lib/mail/graph";
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
    const thread =
      session.provider === "google"
        ? await getGmailThreadMessages(session.accessToken, message.threadId)
        : await getGraphConversationMessages(
            session.accessToken,
            message.threadId,
          );

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
            listArchive:
              session.provider === "google"
                ? (token, max) =>
                    searchGmail(
                      token,
                      "-in:inbox -in:sent -in:trash -in:spam is:read",
                      max,
                    )
                : undefined,
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
          // Full-body depth: "amount due" on page two still counts
          snippet: (bodyText || message.snippet).slice(0, 2000),
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
      // threadLast MUST match the list path: the reader saying "awaiting
      // their reply" while triage says "Reply to Rebecca" was the two
      // views grading with different context.
      {
        personal,
        actionMemory,
        labels,
        geminiEnabled: false,
        replied,
        threadLast:
          session.provider === "google"
            ? (threadId) => getGmailThreadLast(session.accessToken, threadId)
            : undefined,
      },
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

    // Calendar invite? Ship the event this email is the invitation for, so
    // the reader can RSVP. The RSVP route resolves it the same way.
    const calendarEvent = (
      await resolveInviteEvent({
        provider: session.provider,
        accessToken: session.accessToken,
        personal,
        message,
      })
    )?.event;

    // Your own messages read as "You", not your full name — no more
    // guessing who sent what inside a thread.
    const displayMessage =
      message.fromEmail.toLowerCase() === session.email.toLowerCase()
        ? { ...message, fromName: "You" }
        : message;

    return NextResponse.json({
      message: displayMessage,
      thread: thread.map((turn) =>
        turn.fromEmail.toLowerCase() === session.email.toLowerCase()
          ? { ...turn, fromName: "You" }
          : turn,
      ),
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
