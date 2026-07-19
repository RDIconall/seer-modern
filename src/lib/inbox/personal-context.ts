import { promises as fs } from "fs";
import path from "path";

/**
 * Who you know (contacts) and what you're about to do (calendar) are
 * strong predictors of what you'll do with an email. Server-only;
 * cached to disk; degrades to empty if scopes weren't granted yet.
 */

export type CalendarEventLite = {
  subject: string;
  startsAt: string;
  attendees: string[];
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

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");
const TTL_FULL_MS = 6 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 10 * 60 * 1000; // retry soon if scopes were missing
const LOOKAHEAD_DAYS = 14;

const EMPTY: PersonalContext = { builtAt: "", contacts: [], events: [] };

function fileFor(accountEmail: string) {
  const safe = accountEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return path.join(DATA_DIR, `personal-${safe}.json`);
}

async function readCache(accountEmail: string): Promise<PersonalContext | null> {
  try {
    const raw = await fs.readFile(fileFor(accountEmail), "utf8");
    const parsed = JSON.parse(raw) as PersonalContext;
    const age = Date.now() - new Date(parsed.builtAt).getTime();
    const empty = parsed.contacts.length === 0 && parsed.events.length === 0;
    if (age > (empty ? TTL_EMPTY_MS : TTL_FULL_MS)) return null;
    return parsed;
  } catch {
    return null;
  }
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
      maxResults: "50",
    });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await safeJson(res);
  const items = (json.items ?? []) as Array<{
    summary?: string;
    start?: { dateTime?: string; date?: string };
    attendees?: { email?: string }[];
  }>;
  return items.map((e) => ({
    subject: e.summary ?? "(no title)",
    startsAt: e.start?.dateTime ?? e.start?.date ?? "",
    attendees: (e.attendees ?? [])
      .map((a) => a.email?.toLowerCase().trim() ?? "")
      .filter(Boolean),
  }));
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

async function graphEvents(token: string): Promise<CalendarEventLite[]> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const url =
    "https://graph.microsoft.com/v1.0/me/calendarView?" +
    new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: max.toISOString(),
      $select: "subject,start,attendees",
      $top: "50",
      $orderby: "start/dateTime",
    });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await safeJson(res);
  const values = (json.value ?? []) as Array<{
    subject?: string;
    start?: { dateTime?: string };
    attendees?: { emailAddress?: { address?: string } }[];
  }>;
  return values.map((e) => ({
    subject: e.subject ?? "(no title)",
    startsAt: e.start?.dateTime ?? "",
    attendees: (e.attendees ?? [])
      .map((a) => a.emailAddress?.address?.toLowerCase().trim() ?? "")
      .filter(Boolean),
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
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      fileFor(session.accountEmail),
      JSON.stringify(ctx),
      "utf8",
    );
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
