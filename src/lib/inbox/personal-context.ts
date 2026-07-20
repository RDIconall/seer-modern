import { accountKey, kvGet, kvSet } from "@/lib/store/kv";

/**
 * Who you know (contacts) and what you're about to do (calendar) are
 * strong predictors of what you'll do with an email. Server-only;
 * cached via the KV store; degrades to empty if scopes weren't granted.
 */

export type RsvpStatus = "needsAction" | "accepted" | "declined" | "tentative";

export type CalendarEventLite = {
  /** Provider event id — needed to RSVP from inside Seer */
  id?: string;
  subject: string;
  startsAt: string;
  attendees: string[];
  /** The user's OWN response on this event */
  myStatus?: RsvpStatus;
};

export type PersonalContext = {
  builtAt: string;
  contacts: string[];
  events: CalendarEventLite[];
};

export type ContextSignals = {
  inContacts: boolean;
  /** Next upcoming event this sender is attending, if any. */
  meeting: { subject: string; startsAt: string } | null;
};

const TTL_FULL_MS = 6 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 10 * 60 * 1000; // retry soon if scopes were missing
// Long enough to match invite emails for events weeks out
const LOOKAHEAD_DAYS = 60;

const EMPTY: PersonalContext = { builtAt: "", contacts: [], events: [] };

function keyFor(accountEmail: string) {
  return `personal:${accountKey(accountEmail)}`;
}

async function readCache(accountEmail: string): Promise<PersonalContext | null> {
  const parsed = await kvGet<PersonalContext>(keyFor(accountEmail));
  if (!parsed) return null;
  const age = Date.now() - new Date(parsed.builtAt).getTime();
  const empty = parsed.contacts.length === 0 && parsed.events.length === 0;
  if (age > (empty ? TTL_EMPTY_MS : TTL_FULL_MS)) return null;
  return parsed;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------- Google (People + Calendar APIs) ----------

async function googleContacts(token: string): Promise<string[]> {
  const out = new Set<string>();
  const urls = [
    "https://people.googleapis.com/v1/people/me/connections?personFields=emailAddresses&pageSize=500",
    "https://people.googleapis.com/v1/otherContacts?readMask=emailAddresses&pageSize=500",
  ];
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue; // scope not granted yet — skip quietly
    const json = await safeJson(res);
    const people = (json.connections ?? json.otherContacts ?? []) as Array<{
      emailAddresses?: { value?: string }[];
    }>;
    for (const p of people) {
      for (const e of p.emailAddresses ?? []) {
        if (e.value) out.add(e.value.toLowerCase().trim());
      }
    }
  }
  return [...out];
}

async function googleEvents(token: string): Promise<CalendarEventLite[]> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
    new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: max.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await safeJson(res);
  const items = (json.items ?? []) as Array<{
    id?: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  }>;
  return items.map((e) => {
    const mine = (e.attendees ?? []).find((a) => a.self);
    return {
      id: e.id,
      subject: e.summary ?? "(no title)",
      startsAt: e.start?.dateTime ?? e.start?.date ?? "",
      attendees: (e.attendees ?? [])
        .map((a) => a.email?.toLowerCase().trim() ?? "")
        .filter(Boolean),
      myStatus: (mine?.responseStatus as RsvpStatus | undefined) ?? undefined,
    };
  });
}

// ---------- Microsoft Graph ----------

async function graphContacts(token: string): Promise<string[]> {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me/contacts?$select=emailAddresses&$top=500",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const json = await safeJson(res);
  const out = new Set<string>();
  const values = (json.value ?? []) as Array<{
    emailAddresses?: { address?: string }[];
  }>;
  for (const c of values) {
    for (const e of c.emailAddresses ?? []) {
      if (e.address) out.add(e.address.toLowerCase().trim());
    }
  }
  return [...out];
}

const GRAPH_STATUS: Record<string, RsvpStatus> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  notResponded: "needsAction",
  none: "needsAction",
};

async function graphEvents(token: string): Promise<CalendarEventLite[]> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const url =
    "https://graph.microsoft.com/v1.0/me/calendarView?" +
    new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: max.toISOString(),
      $select: "id,subject,start,attendees,responseStatus",
      $top: "100",
      $orderby: "start/dateTime",
    });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await safeJson(res);
  const values = (json.value ?? []) as Array<{
    id?: string;
    subject?: string;
    start?: { dateTime?: string };
    attendees?: { emailAddress?: { address?: string } }[];
    responseStatus?: { response?: string };
  }>;
  return values.map((e) => ({
    id: e.id,
    subject: e.subject ?? "(no title)",
    startsAt: e.start?.dateTime ?? "",
    attendees: (e.attendees ?? [])
      .map((a) => a.emailAddress?.address?.toLowerCase().trim() ?? "")
      .filter(Boolean),
    myStatus: GRAPH_STATUS[e.responseStatus?.response ?? ""] ?? undefined,
  }));
}

// ---------- Public API ----------

export async function getPersonalContext(session: {
  accountEmail: string;
  accessToken: string;
  provider: "google" | "microsoft" | string;
}): Promise<PersonalContext> {
  const cached = await readCache(session.accountEmail);
  if (cached) return cached;

  try {
    const [contacts, events] =
      session.provider === "google"
        ? await Promise.all([
            googleContacts(session.accessToken),
            googleEvents(session.accessToken),
          ])
        : await Promise.all([
            graphContacts(session.accessToken),
            graphEvents(session.accessToken),
          ]);

    const ctx: PersonalContext = {
      builtAt: new Date().toISOString(),
      contacts,
      events,
    };
    await kvSet(keyFor(session.accountEmail), ctx);
    return ctx;
  } catch {
    return { ...EMPTY, builtAt: new Date().toISOString() };
  }
}

export function contextSignals(
  ctx: PersonalContext | null | undefined,
  fromEmail: string,
): ContextSignals {
  const email = fromEmail.toLowerCase().trim();
  if (!ctx) return { inContacts: false, meeting: null };

  const inContacts = ctx.contacts.includes(email);

  let meeting: ContextSignals["meeting"] = null;
  for (const e of ctx.events) {
    if (!e.startsAt || !e.attendees.includes(email)) continue;
    if (!meeting || e.startsAt < meeting.startsAt) {
      meeting = { subject: e.subject, startsAt: e.startsAt };
    }
  }
  return { inContacts, meeting };
}

// ---------- Calendar invites (Google actions inside the email) ----------

const INVITE_SUBJECT =
  /^\s*(?:updated\s+)?invitation[:\s]+(.+?)(?:\s+@\s+.+)?\s*$/i;

/** Organizer-side RSVP receipts: "Accepted: Standup @ Tue…" */
export const RSVP_RECEIPT_SUBJECT =
  /^\s*(accepted|declined|tentatively accepted|new time proposed)[:\s]/i;

export type InviteSignals = {
  /** Matched upcoming calendar event for this invite email */
  event: CalendarEventLite;
  /** True when the user has already answered (in Gmail, Calendar, or Seer) */
  answered: boolean;
};

/**
 * Match an "Invitation: …" email to the user's calendar and report
 * whether they already responded — a native Google action inside the
 * email that the triage engine treats as "handled".
 */
export function inviteSignals(
  ctx: PersonalContext | null | undefined,
  subject: string,
): InviteSignals | null {
  if (!ctx?.events?.length) return null;
  const m = subject.match(INVITE_SUBJECT);
  const title = m?.[1]?.trim().toLowerCase();
  if (!title) return null;

  const event = ctx.events.find((e) => {
    const t = e.subject.trim().toLowerCase();
    return t.length > 2 && (title === t || title.startsWith(t) || t.startsWith(title));
  });
  if (!event) return null;

  return {
    event,
    answered: Boolean(event.myStatus && event.myStatus !== "needsAction"),
  };
}

/** Rewrite one event's RSVP in the cached context (instant UI truth). */
export async function updateCachedRsvp(
  accountEmail: string,
  eventId: string,
  status: RsvpStatus,
): Promise<void> {
  const ctx = await kvGet<PersonalContext>(keyFor(accountEmail));
  if (!ctx) return;
  let touched = false;
  for (const e of ctx.events) {
    if (e.id === eventId) {
      e.myStatus = status;
      touched = true;
    }
  }
  if (touched) await kvSet(keyFor(accountEmail), ctx);
}

/** Human-readable "Standup · in 2d" for prompts and UI. */
export function meetingLabel(
  meeting: ContextSignals["meeting"],
): string | null {
  if (!meeting) return null;
  const days = Math.max(
    0,
    Math.round(
      (new Date(meeting.startsAt).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000),
    ),
  );
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;
  return `${meeting.subject.slice(0, 50)} · ${when}`;
}
