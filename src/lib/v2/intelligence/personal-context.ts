import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { MailAccount } from "../db/accounts";
import { asAccountId, asUserId } from "../db/types";
import { accessTokenFor } from "../providers/provider";
import { graphRawFetch } from "@/lib/mail/graph";

/**
 * Live contacts and calendar, cached in Postgres. Microsoft Graph is the
 * primary path (Conall's mailbox). Google is supported with the same shape.
 * Failures degrade to empty — a read still happens, just without the meeting.
 */

export type RsvpStatus = "needsAction" | "accepted" | "declined" | "tentative";

export type CalendarEventLite = {
  id?: string;
  subject: string;
  startsAt: string;
  attendees: string[];
  myStatus?: RsvpStatus;
};

export type PersonalContext = {
  contacts: string[];
  autoContacts: string[];
  events: CalendarEventLite[];
  timezone: string | null;
  health: { people: string; calendar: string };
  contactsBuiltAt: string | null;
  eventsBuiltAt: string | null;
};

export type ContextSignals = {
  inContacts: boolean;
  autoContact: boolean;
  meeting: { subject: string; startsAt: string } | null;
};

const TTL_CONTACTS_MS = 6 * 60 * 60 * 1000;
const TTL_EMPTY_MS = 10 * 60 * 1000;
const TTL_EVENTS_MS = 5 * 60 * 1000;
const LOOKAHEAD_DAYS = 21;
const MAX_EVENTS = 200;
const MAX_CONTACTS = 500;

const EMPTY: PersonalContext = {
  contacts: [],
  autoContacts: [],
  events: [],
  timezone: null,
  health: { people: "skipped", calendar: "skipped" },
  contactsBuiltAt: null,
  eventsBuiltAt: null,
};

const GRAPH_STATUS: Record<string, RsvpStatus> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  notResponded: "needsAction",
  none: "needsAction",
};

function ageOf(iso: string | null | undefined): number {
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

export function parseGraphContacts(json: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const values = (json.value ?? []) as Array<{
    emailAddresses?: { address?: string }[];
  }>;
  for (const contact of values) {
    for (const email of contact.emailAddresses ?? []) {
      if (email.address) out.add(email.address.toLowerCase().trim());
    }
  }
  return [...out].slice(0, MAX_CONTACTS);
}

export function parseGraphEvents(json: Record<string, unknown>): CalendarEventLite[] {
  const values = (json.value ?? []) as Array<{
    id?: string;
    subject?: string;
    start?: { dateTime?: string; timeZone?: string };
    attendees?: { emailAddress?: { address?: string } }[];
    responseStatus?: { response?: string };
  }>;
  return values.map((event) => ({
    id: event.id,
    subject: event.subject ?? "(no title)",
    startsAt: toIso(event.start?.dateTime),
    attendees: (event.attendees ?? [])
      .map((a) => a.emailAddress?.address?.toLowerCase().trim() ?? "")
      .filter(Boolean),
    myStatus: GRAPH_STATUS[event.responseStatus?.response ?? ""] ?? undefined,
  }));
}

export function parseGoogleEvents(json: Record<string, unknown>): CalendarEventLite[] {
  const items = (json.items ?? []) as Array<{
    id?: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  }>;
  return items.map((event) => {
    const mine = (event.attendees ?? []).find((a) => a.self);
    return {
      id: event.id,
      subject: event.summary ?? "(no title)",
      startsAt: event.start?.dateTime ?? event.start?.date ?? "",
      attendees: (event.attendees ?? [])
        .map((a) => a.email?.toLowerCase().trim() ?? "")
        .filter(Boolean),
      myStatus: (mine?.responseStatus as RsvpStatus | undefined) ?? undefined,
    };
  });
}

function toIso(value: string | undefined): string {
  if (!value) return "";
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value).toISOString();
  const parsed = new Date(`${value}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function graphContacts(token: string): Promise<{ emails: string[]; status: string }> {
  const res = await graphRawFetch(
    "https://graph.microsoft.com/v1.0/me/contacts?$select=emailAddresses&$top=500",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    return {
      emails: [],
      status: res.status === 403 ? "permission missing — reconnect the account" : `http ${res.status}`,
    };
  }
  return { emails: parseGraphContacts(await safeJson(res)), status: "ok" };
}

async function graphMailboxTimezone(token: string): Promise<string | null> {
  const res = await graphRawFetch(
    "https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const json = await safeJson(res);
  return typeof json.value === "string" && json.value.trim() ? json.value.trim() : null;
}

async function graphEvents(
  token: string,
  timezone: string | null,
): Promise<{ events: CalendarEventLite[]; status: string }> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const tz = timezone && /[A-Za-z]/.test(timezone) ? timezone : "UTC";
  const url =
    "https://graph.microsoft.com/v1.0/me/calendarView?" +
    new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: max.toISOString(),
      $select: "id,subject,start,attendees,responseStatus",
      $top: "200",
      $orderby: "start/dateTime",
    });
  const res = await graphRawFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: `outlook.timezone="${tz}"`,
    },
  });
  if (!res.ok) {
    return {
      events: [],
      status: res.status === 403 ? "permission missing — reconnect the account" : `http ${res.status}`,
    };
  }
  const json = await safeJson(res);
  return { events: parseGraphEvents(json).slice(0, MAX_EVENTS), status: "ok" };
}

async function googleContacts(token: string): Promise<{
  saved: string[];
  auto: string[];
  status: string;
}> {
  const pull = async (url: string, field: string) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      return {
        emails: [] as string[],
        status:
          res.status === 403
            ? "permission missing — reconnect the account"
            : `http ${res.status}`,
      };
    }
    const json = await safeJson(res);
    const people = (json[field] ?? []) as Array<{
      emailAddresses?: { value?: string }[];
    }>;
    const emails = new Set<string>();
    for (const person of people) {
      for (const email of person.emailAddresses ?? []) {
        if (email.value) emails.add(email.value.toLowerCase().trim());
      }
    }
    return { emails: [...emails], status: "ok" };
  };
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
    saved: saved.emails.slice(0, MAX_CONTACTS),
    auto: auto.emails.filter((email) => !savedSet.has(email)).slice(0, MAX_CONTACTS),
    status: saved.status,
  };
}

async function googleEvents(
  token: string,
): Promise<{ events: CalendarEventLite[]; status: string }> {
  const now = new Date();
  const max = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
    new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: max.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "200",
    });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return {
      events: [],
      status: res.status === 403 ? "permission missing — reconnect the account" : `http ${res.status}`,
    };
  }
  return { events: parseGoogleEvents(await safeJson(res)).slice(0, MAX_EVENTS), status: "ok" };
}

type CacheRow = {
  contacts: string[];
  auto_contacts: string[];
  events: CalendarEventLite[] | string;
  timezone: string | null;
  people_status: string | null;
  calendar_status: string | null;
  contacts_built_at: Date | string | null;
  events_built_at: Date | string | null;
};

function fromRow(row: CacheRow | undefined): PersonalContext | null {
  if (!row) return null;
  const events = Array.isArray(row.events)
    ? row.events
    : typeof row.events === "string"
      ? (JSON.parse(row.events) as CalendarEventLite[])
      : [];
  return {
    contacts: row.contacts ?? [],
    autoContacts: row.auto_contacts ?? [],
    events,
    timezone: row.timezone,
    health: {
      people: row.people_status ?? "ok",
      calendar: row.calendar_status ?? "ok",
    },
    contactsBuiltAt: row.contacts_built_at
      ? new Date(row.contacts_built_at).toISOString()
      : null,
    eventsBuiltAt: row.events_built_at
      ? new Date(row.events_built_at).toISOString()
      : null,
  };
}

async function loadAccount(accountId: AccountId): Promise<MailAccount | null> {
  const result = await db().query<{
    id: string;
    user_id: string;
    provider: MailAccount["provider"];
    email: string;
    display_name: string | null;
    status: MailAccount["status"];
  }>(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
  };
}

/**
 * Cached personal context for one mailbox. Refresh is best-effort and must
 * never fail a chief-of-staff read.
 */
export async function loadPersonalContext(
  accountId: AccountId,
): Promise<PersonalContext> {
  try {
    const cached = await db().query<CacheRow>(
      `select contacts, auto_contacts, events, timezone, people_status, calendar_status,
              contacts_built_at, events_built_at
         from seer.personal_context_cache
        where account_id = $1`,
      [accountId],
    );
    const current = fromRow(cached.rows[0]);
    const contactsTtl =
      current && current.contacts.length === 0 ? TTL_EMPTY_MS : TTL_CONTACTS_MS;
    const contactsFresh = Boolean(
      current && ageOf(current.contactsBuiltAt) < contactsTtl,
    );
    const eventsFresh = Boolean(
      current && ageOf(current.eventsBuiltAt) < TTL_EVENTS_MS,
    );
    if (current && contactsFresh && eventsFresh) return current;

    const account = await loadAccount(accountId);
    if (!account || account.status !== "active") {
      return current ?? EMPTY;
    }

    let token: string;
    try {
      token = await accessTokenFor(account);
    } catch {
      return current ?? { ...EMPTY, health: { people: "no token", calendar: "no token" } };
    }

    const [people, calendar] = await Promise.all([
      contactsFresh && current
        ? Promise.resolve({
            saved: current.contacts,
            auto: current.autoContacts,
            status: current.health.people,
          })
        : account.provider === "microsoft"
          ? graphContacts(token).then((result) => ({
              saved: result.emails,
              auto: [] as string[],
              status: result.status,
            }))
          : googleContacts(token),
      eventsFresh && current
        ? Promise.resolve({
            events: current.events,
            timezone: current.timezone,
            status: current.health.calendar,
          })
        : account.provider === "microsoft"
          ? (async () => {
              const timezone =
                current?.timezone ?? (await graphMailboxTimezone(token));
              const fetched = await graphEvents(token, timezone);
              return { ...fetched, timezone };
            })()
          : googleEvents(token).then((fetched) => ({
              ...fetched,
              timezone: current?.timezone ?? null,
            })),
    ]);

    const nowIso = new Date().toISOString();
    const next: PersonalContext = {
      contacts: people.saved,
      autoContacts: people.auto,
      events: calendar.events,
      timezone: calendar.timezone ?? current?.timezone ?? null,
      health: { people: people.status, calendar: calendar.status },
      contactsBuiltAt: contactsFresh && current ? current.contactsBuiltAt : nowIso,
      eventsBuiltAt: eventsFresh && current ? current.eventsBuiltAt : nowIso,
    };

    await db().query(
      `insert into seer.personal_context_cache
         (account_id, contacts, auto_contacts, events, timezone, people_status,
          calendar_status, contacts_built_at, events_built_at, updated_at)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,now())
       on conflict (account_id) do update set
         contacts = excluded.contacts,
         auto_contacts = excluded.auto_contacts,
         events = excluded.events,
         timezone = excluded.timezone,
         people_status = excluded.people_status,
         calendar_status = excluded.calendar_status,
         contacts_built_at = excluded.contacts_built_at,
         events_built_at = excluded.events_built_at,
         updated_at = now()`,
      [
        accountId,
        next.contacts,
        next.autoContacts,
        JSON.stringify(next.events),
        next.timezone,
        next.health.people,
        next.health.calendar,
        next.contactsBuiltAt,
        next.eventsBuiltAt,
      ],
    );
    return next;
  } catch (error) {
    console.error(
      "[seer:v2] personal context unavailable:",
      error instanceof Error ? error.message : error,
    );
    return EMPTY;
  }
}

export function contextSignals(
  ctx: PersonalContext | null | undefined,
  fromEmail: string,
): ContextSignals {
  const email = fromEmail.toLowerCase().trim();
  if (!ctx) return { inContacts: false, autoContact: false, meeting: null };
  const inContacts = ctx.contacts.includes(email);
  const autoContact = !inContacts && ctx.autoContacts.includes(email);
  let meeting: ContextSignals["meeting"] = null;
  for (const event of ctx.events) {
    if (!event.startsAt || !event.attendees.includes(email)) continue;
    if (!meeting || event.startsAt < meeting.startsAt) {
      meeting = { subject: event.subject, startsAt: event.startsAt };
    }
  }
  return { inContacts, autoContact, meeting };
}

const INVITE_SUBJECT =
  /^\s*(?:updated\s+)?invitation[:\s]+(.+?)(?:\s+@\s+.+)?\s*$/i;

export function inviteAnswered(
  ctx: PersonalContext | null | undefined,
  subject: string,
): boolean {
  if (!ctx?.events.length) return false;
  const match = subject.match(INVITE_SUBJECT);
  const title = match?.[1]?.trim().toLowerCase();
  if (!title) return false;
  const event = ctx.events.find((item) => {
    const t = item.subject.trim().toLowerCase();
    return t.length > 2 && (title === t || title.startsWith(t) || t.startsWith(title));
  });
  return Boolean(event?.myStatus && event.myStatus !== "needsAction");
}

/**
 * Next free weekday morning slot from cached events. Best-effort; skipped
 * when timezone is unknown so we never invent "Tue 9am" in the wrong zone.
 */
export function nextFreeSlot(
  ctx: PersonalContext | null | undefined,
  now = new Date(),
): string | null {
  if (!ctx?.timezone) return null;
  const tz = /[A-Za-z]/.test(ctx.timezone) ? ianaFromWindows(ctx.timezone) : "UTC";
  for (let day = 1; day <= 7; day++) {
    const cursor = new Date(now.getTime() + day * 86_400_000);
    const weekday = weekdayIn(cursor, tz);
    if (weekday === 0 || weekday === 6) continue;
    for (const hour of [9, 10, 11]) {
      const local = wallTime(cursor, tz, hour, 0);
      if (!local) continue;
      const busy = ctx.events.some((event) => {
        const start = Date.parse(event.startsAt);
        return Number.isFinite(start) && Math.abs(start - local.getTime()) < 45 * 60_000;
      });
      if (!busy) {
        const label = local.toLocaleString("en-US", {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZone: tz,
        });
        return label.replace(":00", "").replace(" AM", "am").replace(" PM", "pm");
      }
    }
  }
  return null;
}

function weekdayIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone,
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts);
}

function wallTime(
  day: Date,
  timeZone: string,
  hour: number,
  minute: number,
): Date | null {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(day);
  const [year, month, date] = ymd.split("-").map(Number);
  if (!year || !month || !date) return null;
  let utc = Date.UTC(year, month - 1, date, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(utc));
    const num = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const gotHour = num("hour");
    const gotMinute = num("minute");
    const gotDay = num("day");
    if (
      Number.isNaN(gotHour) ||
      Number.isNaN(gotMinute) ||
      Number.isNaN(gotDay)
    ) {
      return null;
    }
    const deltaMin =
      (hour - gotHour) * 60 + (minute - gotMinute) + (date - gotDay) * 24 * 60;
    if (deltaMin === 0) return new Date(utc);
    utc += deltaMin * 60_000;
  }
  return new Date(utc);
}

/** Graph returns Windows timezone names; slot math wants IANA. */
export function ianaFromWindows(value: string): string {
  const map: Record<string, string> = {
    "Pacific Standard Time": "America/Los_Angeles",
    "Pacific Daylight Time": "America/Los_Angeles",
    "Mountain Standard Time": "America/Denver",
    "Central Standard Time": "America/Chicago",
    "Eastern Standard Time": "America/New_York",
    "GMT Standard Time": "Europe/London",
    UTC: "UTC",
  };
  return map[value] ?? (/^[A-Za-z]+\/[A-Za-z_]+$/.test(value) ? value : "UTC");
}
