import { getGmailMessage, gmailAction } from "@/lib/mail/gmail";
import { requireMailSession } from "@/lib/mail/session";
import {
  googleOrganizer,
  resolveInviteEvent,
  type GoogleCalendarEvent,
} from "@/lib/inbox/invite-event";
import {
  getPersonalContext,
  isInviteFor,
  updateCachedRsvp,
  type RsvpStatus,
} from "@/lib/inbox/personal-context";
import { NextResponse } from "next/server";

export const maxDuration = 30;

const RESPONSES = new Set<RsvpStatus>(["accepted", "declined", "tentative"]);

function notThisInvite() {
  return NextResponse.json(
    { error: "This email isn't the invitation for that event" },
    { status: 409 },
  );
}

/**
 * One-tap RSVP from inside the email — the Google action IS the triage
 * action. Sets the user's response on the calendar event, updates the
 * cached context so cards flip instantly, and archives the invite email.
 *
 * The event is the one this message is the invitation for, resolved here
 * from the message. A posted eventId that isn't that event is refused.
 */
export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (session.provider !== "google") {
      return NextResponse.json(
        { error: "RSVP from Seer is Gmail-only for now" },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      eventId?: string;
      response?: RsvpStatus;
      messageId?: string;
    };
    if (
      !body.eventId ||
      !body.messageId ||
      !body.response ||
      !RESPONSES.has(body.response)
    ) {
      return NextResponse.json(
        {
          error:
            "Provide { eventId, messageId, response: accepted|declined|tentative }",
        },
        { status: 400 },
      );
    }

    const [message, personal] = await Promise.all([
      getGmailMessage(session.accessToken, body.messageId),
      getPersonalContext({
        accountEmail: session.email,
        accessToken: session.accessToken,
        provider: session.provider,
      }),
    ]);
    const resolved = await resolveInviteEvent({
      provider: session.provider,
      accessToken: session.accessToken,
      personal,
      message,
    });
    if (!resolved || resolved.event.id !== body.eventId) {
      return notThisInvite();
    }
    const eventId = resolved.event.id;

    const base = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
    const headers = {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    };

    let event: GoogleCalendarEvent | undefined = resolved.live;
    if (!event) {
      const getRes = await fetch(base, { headers, cache: "no-store" });
      if (!getRes.ok) {
        const errText = await getRes.text().catch(() => "");
        const detail = /accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(
          errText,
        )
          ? "The app's Google project has the Calendar API disabled — enable it in the Google Cloud console (APIs & Services → Calendar API → Enable)."
          : getRes.status === 403 || getRes.status === 401
            ? "Sign in again in Settings to grant calendar write access."
            : `Calendar lookup failed (${getRes.status}).`;
        return NextResponse.json({ error: detail }, { status: 502 });
      }
      event = (await getRes.json()) as GoogleCalendarEvent;
      // Matched from the cached calendar by subject: the live event must
      // still be that invite before it is answered.
      if (
        !isInviteFor(
          {
            subject: event.summary ?? "",
            organizer: googleOrganizer(event) || undefined,
          },
          message.subject,
          message.fromEmail,
        )
      ) {
        return notThisInvite();
      }
    }
    if (event.id !== eventId) return notThisInvite();

    const attendees = (event.attendees ?? []).map((a) =>
      a.self ? { ...a, responseStatus: body.response } : a,
    );
    if (!attendees.some((a) => a.self)) {
      return NextResponse.json(
        { error: "You aren't an attendee on this event" },
        { status: 400 },
      );
    }

    // If-Match pins the write to the event version that was verified above.
    const patch = await fetch(`${base}?sendUpdates=all`, {
      method: "PATCH",
      headers: event.etag ? { ...headers, "If-Match": event.etag } : headers,
      body: JSON.stringify({ attendees }),
      cache: "no-store",
    });
    if (!patch.ok) {
      const errText = await patch.text().catch(() => "");
      const detail = /accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(
        errText,
      )
        ? "The app's Google project has the Calendar API disabled — enable it in the Google Cloud console (APIs & Services → Calendar API → Enable)."
        : patch.status === 412
          ? "The event changed — reopen the invite and try again."
          : patch.status === 403
            ? "Sign in again in Settings to grant calendar write access."
            : `RSVP failed (${patch.status}).`;
      return NextResponse.json(
        { error: detail },
        { status: patch.status === 412 ? 409 : 502 },
      );
    }

    // Instant truth for the next triage pass + archive the invite email
    await updateCachedRsvp(session.email, eventId, body.response).catch(
      () => {},
    );
    await gmailAction(session.accessToken, message.id, "archive").catch(
      () => {},
    );

    return NextResponse.json({ ok: true, response: body.response });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "RSVP failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
