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
  /** SAVED contacts only — the user's hand-curated address book. */
  contacts: string[];
  /** Google's auto-collected "other contacts" (anyone ever emailed).
   *  NOT a relationship — only counts alongside real mail history. */
  autoContacts?: string[];
  events: CalendarEventLite[];
  /** Events refresh on a much shorter clock than contacts */
  eventsBuiltAt?: string;
  /** Per-API status from the last fetch — silent failures are banned. */
  health?: { people: string; calendar: string };
};

export type ContextSignals = {
  /** True only for the user's SAVED address book. */
  inContacts: boolean;
  /** Google auto-collected this address — weak signal, verify strength. */
  autoContact: boolean;
  /** Next upcoming event this sender is attending, if any. */
  meeting: { subject: string; startsAt: string } | null;
};

const TTL_FULL_MS = 6 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 10 * 60 * 1000; // retry soon if scopes were missing
// RSVPs made in Gmail/Calendar must show up in Seer fast
const TTL_EVENTS_MS = 5 * 60 * 1000;
// ANY invitation should match — look a full year out
const LOOKAHEAD_DAYS = 365;
const MAX_EVENTS = 500;

const EMPTY: PersonalContext = { builtAt: "", contacts: [], events: [] };

function keyFor(accountEmail: string) {
  return `personal:${accountKey(accountEmail)}`;
}

function ageOf(iso: string | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  return Date.now() - new Date(iso).getTime();
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------- Google (People + Calendar APIs) ----------

/** Names the failure instead of hiding it — "disabled" vs "no scope". */
async function apiStatus(res: Response): Promise<string> {
  if (res.ok) return "ok";
  const body = await res.text().catch(() => "");
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project/i.test(body)) {
    return "API disabled in the app's Google Cloud project";
  }
  if (res.status === 401 || res.status === 403) {
    return "permission missing — reconnect the account";
  }
  return `http ${res.status}`;
}

async function googleContacts(token: string): Promise<{
  saved: string[];
  auto: string[];
  status: string;
}> {
  const pull = async (url: string, field: string): Promise<{ emails: string[]; status: string }> => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = await apiStatus(res);
    if (status !== "ok") return { emails: [], status };
    const json = await safeJson(res);
    const people = (json[field] ?? []) as Array<{
      emailAddresses?: { value?: string }[];
    }>;
    const out = new Set<string>();
    for (const p of people) {
      for (const e of p.emailAddresses ?? []) {
        if (e.value) out.add(e.value.toLowerCase().trim());
      }
    }
    return { emails: [...out], status };
  };

  // SAVED contacts (real address book) and Google's auto-collected
  // "other contacts" are different animals — kept separate on purpose.
  const [saved, auto] = await Promise.all([
    pull(
      "https://people.googleapis.com/v1/people/me/connections?personFields=emailAddresses&pageSize=500",
      "connections",
    ),
    pull(
      "https://people.googleapis.com/v1/otherContacts?readMask=emailAddresses&pageSize=500",
      "otherContacts",
    ),
  ]);
  const savedSet = new Set(saved.emails);
  return {
    saved: saved.emails,
    auto: auto.emails.filter((e) => !savedSet.has(e)),
    status: saved.status,
  };
}

async function googleEvents(
  token: string,
): Promise<{ events: CalendarEventLite[]; status: string }> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const out: CalendarEventLite[] = [];
  let pageToken: string | undefined;
  let status = "ok";

  while (out.length < MAX_EVENTS) {
    const url =
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
      new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: max.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      status = await apiStatus(res);
      break;
    }
    const json = await safeJson(res);
    const items = (json.items ?? []) as Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
    }>;
    for (const e of items) {
      const mine = (e.attendees ?? []).find((a) => a.self);
      out.push({
        id: e.id,
        subject: e.summary ?? "(no title)",
        startsAt: e.start?.dateTime ?? e.start?.date ?? "",
        attendees: (e.attendees ?? [])
          .map((a) => a.email?.toLowerCase().trim() ?? "")
          .filter(Boolean),
        myStatus:
          (mine?.responseStatus as RsvpStatus | undefined) ?? undefined,
      });
    }
    pageToken = json.nextPageToken as string | undefined;
    if (!pageToken || items.length === 0) break;
  }
  return { events: out.slice(0, MAX_EVENTS), status };
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
  const first =
    "https://graph.microsoft.com/v1.0/me/calendarView?" +
    new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: max.toISOString(),
      $select: "id,subject,start,attendees,responseStatus",
      $top: "250",
      $orderby: "start/dateTime",
    });

  const out: CalendarEventLite[] = [];
  let next: string | undefined = first;
  while (next && out.length < MAX_EVENTS) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;
    const json = await safeJson(res);
    const values = (json.value ?? []) as Array<{
      id?: string;
      subject?: string;
      start?: { dateTime?: string };
      attendees?: { emailAddress?: { address?: string } }[];
      responseStatus?: { response?: string };
    }>;
    for (const e of values) {
      out.push({
        id: e.id,
        subject: e.subject ?? "(no title)",
        startsAt: e.start?.dateTime ?? "",
        attendees: (e.attendees ?? [])
          .map((a) => a.emailAddress?.address?.toLowerCase().trim() ?? "")
          .filter(Boolean),
        myStatus: GRAPH_STATUS[e.responseStatus?.response ?? ""] ?? undefined,
      });
    }
    next = json["@odata.nextLink"] as string | undefined;
    if (!values.length) break;
  }
  return out.slice(0, MAX_EVENTS);
}

// ---------- Public API ----------

export async function getPersonalContext(session: {
  accountEmail: string;
  accessToken: string;
  provider: "google" | "microsoft" | string;
}): Promise<PersonalContext> {
  const cached = await kvGet<PersonalContext>(keyFor(session.accountEmail));

  // Contacts change rarely (6h); events carry live RSVP state, so they
  // refresh every few minutes — an answer given in Gmail or Calendar
  // shows up in Seer on the next load, not hours later.
  const contactsTtl =
    cached && cached.contacts.length === 0 ? TTL_EMPTY_MS : TTL_FULL_MS;
  const contactsFresh = Boolean(cached && ageOf(cached.builtAt) < contactsTtl);
  const eventsFresh = Boolean(
    cached && ageOf(cached.eventsBuiltAt ?? cached.builtAt) < TTL_EVENTS_MS,
  );
  if (cached && contactsFresh && eventsFresh) return cached;

  try {
    const [c, ev] = await Promise.all([
      contactsFresh && cached
        ? Promise.resolve({
            saved: cached.contacts,
            auto: cached.autoContacts ?? [],
            status: cached.health?.people ?? "ok",
          })
        : session.provider === "google"
          ? googleContacts(session.accessToken)
          : graphContacts(session.accessToken).then((saved) => ({
              saved,
              auto: [],
              status: "ok",
            })),
      eventsFresh && cached
        ? Promise.resolve({
            events: cached.events,
            status: cached.health?.calendar ?? "ok",
          })
        : session.provider === "google"
          ? googleEvents(session.accessToken)
          : graphEvents(session.accessToken).then((events) => ({
              events,
              status: "ok",
            })),
    ]);

    const nowIso = new Date().toISOString();
    const ctx: PersonalContext = {
      builtAt: contactsFresh && cached ? cached.builtAt : nowIso,
      eventsBuiltAt:
        eventsFresh && cached
          ? (cached.eventsBuiltAt ?? cached.builtAt)
          : nowIso,
      contacts: c.saved,
      autoContacts: c.auto,
      events: ev.events,
      health: { people: c.status, calendar: ev.status },
    };
    await kvSet(keyFor(session.accountEmail), ctx);
    return ctx;
  } catch {
    return cached ?? { ...EMPTY, builtAt: new Date().toISOString() };
  }
}

export function contextSignals(
  ctx: PersonalContext | null | undefined,
  fromEmail: string,
): ContextSignals {
  const email = fromEmail.toLowerCase().trim();
  if (!ctx) return { inContacts: false, autoContact: false, meeting: null };

  const inContacts = ctx.contacts.includes(email);
  const autoContact =
    !inContacts && Boolean(ctx.autoContacts?.includes(email));

  let meeting: ContextSignals["meeting"] = null;
  for (const e of ctx.events) {
    if (!e.startsAt || !e.attendees.includes(email)) continue;
    if (!meeting || e.startsAt < meeting.startsAt) {
      meeting = { subject: e.subject, startsAt: e.startsAt };
    }
  }
  return { inContacts, autoContact, meeting };
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
