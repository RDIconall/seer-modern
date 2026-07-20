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
import type { RsvpStatus } from "@/lib/inbox/personal-context";
import { NextResponse } from "next/server";

type ReaderEvent = {
  id: string;
  subject: string;
  startsAt: string;
  myStatus?: RsvpStatus;
};

/**
 * Exact invite → event resolution: the .ics inside the email names the
 * event by iCalUID, so ANY invitation resolves — any date, any subject
 * format — with live RSVP state (no cache lag).
 */
async function lookupGoogleEventByUid(
  accessToken: string,
  uid: string,
): Promise<ReaderEvent | null> {
  try {
    const url =
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
      new URLSearchParams({ iCalUID: uid, maxResults: "3" });
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      items?: Array<{
        id?: string;
        summary?: string;
        status?: string;
        start?: { dateTime?: string; date?: string };
        attendees?: { self?: boolean; responseStatus?: string }[];
      }>;
    };
    const ev = (json.items ?? []).find((e) => e.status !== "cancelled");
    if (!ev?.id) return null;
    const mine = (ev.attendees ?? []).find((a) => a.self);
    return {
      id: ev.id,
      subject: ev.summary ?? "(no title)",
      startsAt: ev.start?.dateTime ?? ev.start?.date ?? "",
      myStatus: (mine?.responseStatus as RsvpStatus | undefined) ?? undefined,
    };
  } catch {
    return null;
  }
}

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

    // Calendar invite? Ship the matched event so the reader can RSVP.
    // Prefer the exact iCalUID from the email's own .ics (works for ANY
    // invitation, live status); fall back to subject matching.
    let calendarEvent: ReaderEvent | undefined;
    if (message.icalUid && session.provider === "google") {
      calendarEvent =
        (await lookupGoogleEventByUid(session.accessToken, message.icalUid)) ??
        undefined;
    }
    if (!calendarEvent) {
      const invite = inviteSignals(personal, message.subject);
      if (invite?.event.id != null) {
        calendarEvent = {
          id: invite.event.id,
          subject: invite.event.subject,
          startsAt: invite.event.startsAt,
          myStatus: invite.event.myStatus,
        };
      }
    }

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
