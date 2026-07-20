import { gmailAction } from "@/lib/mail/gmail";
import { requireMailSession } from "@/lib/mail/session";
import {
  updateCachedRsvp,
  type RsvpStatus,
} from "@/lib/inbox/personal-context";
import { NextResponse } from "next/server";

export const maxDuration = 30;

const RESPONSES = new Set<RsvpStatus>(["accepted", "declined", "tentative"]);

/**
 * One-tap RSVP from inside the email — the Google action IS the triage
 * action. Sets the user's response on the calendar event, updates the
 * cached context so cards flip instantly, and archives the invite email.
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
    if (!body.eventId || !body.response || !RESPONSES.has(body.response)) {
      return NextResponse.json(
        { error: "Provide { eventId, response: accepted|declined|tentative }" },
        { status: 400 },
      );
    }

    const base = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(body.eventId)}`;
    const headers = {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    };

    const getRes = await fetch(base, { headers, cache: "no-store" });
    if (!getRes.ok) {
      const detail = getRes.status === 403 || getRes.status === 401
        ? "Sign in again in Settings to grant calendar write access."
        : `Calendar lookup failed (${getRes.status}).`;
      return NextResponse.json({ error: detail }, { status: 502 });
    }
    const event = (await getRes.json()) as {
      attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
    };

    const attendees = (event.attendees ?? []).map((a) =>
      a.self ? { ...a, responseStatus: body.response } : a,
    );
    if (!attendees.some((a) => a.self)) {
      return NextResponse.json(
        { error: "You aren't an attendee on this event" },
        { status: 400 },
      );
    }

    const patch = await fetch(`${base}?sendUpdates=all`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ attendees }),
      cache: "no-store",
    });
    if (!patch.ok) {
      const detail = patch.status === 403
        ? "Sign in again in Settings to grant calendar write access."
        : `RSVP failed (${patch.status}).`;
      return NextResponse.json({ error: detail }, { status: 502 });
    }

    // Instant truth for the next triage pass + archive the invite email
    await updateCachedRsvp(session.email, body.eventId, body.response).catch(
      () => {},
    );
    if (body.messageId) {
      await gmailAction(session.accessToken, body.messageId, "archive").catch(
        () => {},
      );
    }

    return NextResponse.json({ ok: true, response: body.response });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "RSVP failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
