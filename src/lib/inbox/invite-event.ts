import {
  inviteSignals,
  type PersonalContext,
  type RsvpStatus,
} from "@/lib/inbox/personal-context";

/**
 * Server-only: which calendar event an email is the invitation for. The
 * reader shows RSVP buttons for this event and the RSVP route patches only
 * this event, so both resolve it the same way from the message itself.
 */

export type GoogleCalendarEvent = {
  id?: string;
  etag?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
};

export type InviteEvent = {
  id: string;
  subject: string;
  startsAt: string;
  myStatus?: RsvpStatus;
};

export type ResolvedInvite = {
  event: InviteEvent;
  /** The live Google event, when the email's calendar part named it */
  live?: GoogleCalendarEvent;
};

export function googleOrganizer(event: GoogleCalendarEvent): string {
  return event.organizer?.email?.toLowerCase().trim() ?? "";
}

/**
 * Exact invite → event resolution: the .ics inside the email names the
 * event by iCalUID, so ANY invitation resolves — any date, any subject
 * format — with live RSVP state (no cache lag).
 */
async function lookupGoogleEventByUid(
  accessToken: string,
  uid: string,
): Promise<GoogleCalendarEvent | null> {
  try {
    const url =
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
      new URLSearchParams({ iCalUID: uid, maxResults: "3" });
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: GoogleCalendarEvent[] };
    const ev = (json.items ?? []).find((e) => e.status !== "cancelled");
    return ev?.id ? ev : null;
  } catch {
    return null;
  }
}

export async function resolveInviteEvent(input: {
  provider: string;
  accessToken: string;
  personal: PersonalContext | null | undefined;
  message: { fromEmail: string; subject: string; icalUid?: string };
}): Promise<ResolvedInvite | null> {
  const { message } = input;
  const sender = message.fromEmail.toLowerCase().trim();
  if (!sender) return null;

  // A calendar part names its event; it is the only candidate. Its UID is
  // just text in the mail, so the sender must still be that event's
  // organizer, and an unresolved part never falls back to the subject.
  if (message.icalUid && input.provider === "google") {
    const live = await lookupGoogleEventByUid(
      input.accessToken,
      message.icalUid,
    );
    if (!live?.id || googleOrganizer(live) !== sender) return null;
    const mine = (live.attendees ?? []).find((a) => a.self);
    return {
      event: {
        id: live.id,
        subject: live.summary ?? "(no title)",
        startsAt: live.start?.dateTime ?? live.start?.date ?? "",
        myStatus: (mine?.responseStatus as RsvpStatus | undefined) ?? undefined,
      },
      live,
    };
  }

  const invite = inviteSignals(input.personal, message.subject, sender);
  if (invite?.event.id == null) return null;
  return {
    event: {
      id: invite.event.id,
      subject: invite.event.subject,
      startsAt: invite.event.startsAt,
      myStatus: invite.event.myStatus,
    },
  };
}
