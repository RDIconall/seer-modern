/**
 * Invitation subjects must not bind a one-tap RSVP to a different calendar
 * event.
 *
 * These tests exercise the product path: Gmail/Graph message JSON -> the
 * mailbox parsers -> personal calendar context -> inbox grading and the
 * message reader -> the RSVP handler's calendar patch and archive.
 *
 * They fail while a subject that merely starts with "Invitation" can match
 * an event by title prefix, or an event id the message did not resolve can
 * be patched. They pass once an invite is matched only on an exact title
 * and only when the message is a calendar invite from that event's
 * organizer, the reader shows buttons only for that resolved event, and
 * the RSVP route refuses any other event id without patching or archiving.
 *
 * Run:
 *   node --experimental-test-module-mocks --import ./node_modules/tsx/dist/loader.mjs scripts/invite-subject-rsvp.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import React, { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

for (const key of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}
process.env.NODE_ENV = "test";
process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-invite-rsvp-"));

const VICTIM = "victim@example.test";
const ATTACKER = "attacker@example.test";
const BOARD_HOST = "board-host@example.test";
const OFFSITE_HOST = "offsite-host@example.test";
const BUDGET_HOST = "budget-host@example.test";
const GUEST = "guest@example.test";
const TOKEN = "victim-token";

type Attendee = {
  email: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus: "needsAction" | "accepted" | "declined" | "tentative";
};

type FixtureEvent = {
  id: string;
  summary: string;
  start: string;
  iCalUID: string;
  organizer: string;
  attendees: Attendee[];
};

const EVENTS: FixtureEvent[] = [
  {
    id: "evt-early",
    summary: "Offsite",
    start: "2026-12-01T15:00:00.000Z",
    iCalUID: "uid-early",
    organizer: OFFSITE_HOST,
    attendees: [
      { email: OFFSITE_HOST, organizer: true, responseStatus: "accepted" },
      { email: VICTIM, self: true, responseStatus: "accepted" },
      { email: GUEST, responseStatus: "accepted" },
    ],
  },
  {
    id: "evt-mid",
    summary: "Quarterly Board Review",
    start: "2026-12-02T15:00:00.000Z",
    iCalUID: "uid-mid",
    organizer: BOARD_HOST,
    attendees: [
      { email: BOARD_HOST, organizer: true, responseStatus: "accepted" },
      { email: VICTIM, self: true, responseStatus: "needsAction" },
      { email: GUEST, responseStatus: "needsAction" },
    ],
  },
  {
    id: "evt-late",
    summary: "Quarterly Budget",
    start: "2026-12-03T15:00:00.000Z",
    iCalUID: "uid-late",
    organizer: BUDGET_HOST,
    attendees: [
      { email: BUDGET_HOST, organizer: true, responseStatus: "accepted" },
      { email: VICTIM, self: true, responseStatus: "needsAction" },
      { email: GUEST, responseStatus: "needsAction" },
    ],
  },
];

type StoredMessage = {
  id: string;
  from: string;
  subject: string;
  /** text/calendar body. Absent for a normal email. */
  ics?: string;
};

const MESSAGES = new Map<string, StoredMessage>();

function remember(message: StoredMessage): StoredMessage {
  MESSAGES.set(message.id, message);
  return message;
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function gmailMessage(message: StoredMessage) {
  const parts: {
    mimeType: string;
    body: { data: string; size: number };
  }[] = [
    {
      mimeType: "text/plain",
      body: { data: b64url("See you there."), size: 13 },
    },
  ];
  if (message.ics) {
    parts.push({
      mimeType: "text/calendar",
      body: { data: b64url(message.ics), size: message.ics.length },
    });
  }
  return {
    id: message.id,
    threadId: `thr-${message.id}`,
    snippet: "See you there.",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: `Victim <${VICTIM}>` },
        { name: "Subject", value: message.subject },
        { name: "Message-ID", value: `<${message.id}@example.test>` },
      ],
      parts,
    },
  };
}

function ics(uid: string): string {
  return `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

function googleEvent(event: FixtureEvent) {
  return {
    id: event.id,
    summary: event.summary,
    status: "confirmed",
    iCalUID: event.iCalUID,
    organizer: { email: event.organizer, self: false },
    start: { dateTime: event.start },
    end: { dateTime: event.start },
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      self: attendee.self ?? false,
      organizer: attendee.organizer ?? false,
      responseStatus: attendee.responseStatus,
    })),
  };
}

type Rec = { method: string; url: string; body?: string };
const rec: Rec[] = [];
let swapUidAfterFirst = false;
const uidHits = new Map<string, number>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resetMutations(): void {
  rec.length = 0;
  uidHits.clear();
  swapUidAfterFirst = false;
}

function eventById(id: string): FixtureEvent | undefined {
  return EVENTS.find((event) => event.id === id);
}

function eventByUid(uid: string): FixtureEvent | undefined {
  const real = EVENTS.find((event) => event.iCalUID === uid);
  if (!real) return undefined;
  const n = (uidHits.get(uid) ?? 0) + 1;
  uidHits.set(uid, n);
  if (swapUidAfterFirst && n > 1) {
    return EVENTS.find((event) => event.id === "evt-late");
  }
  return real;
}

async function providerFetch(
  urlStr: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body == null ? undefined : String(init.body);
  rec.push({ method, url: urlStr, body });
  const url = new URL(urlStr);

  if (url.hostname === "people.googleapis.com") {
    if (url.pathname.includes("otherContacts")) return json({ otherContacts: [] });
    return json({ connections: [] });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname.includes("/calendar/v3/")) {
    const match = url.pathname.match(/\/calendars\/primary\/events(?:\/([^/]+))?$/);
    if (!match) return json({ items: [] });
    const eventId = match[1] ? decodeURIComponent(match[1]) : undefined;
    if (!eventId) {
      const uid = url.searchParams.get("iCalUID");
      if (uid) {
        const event = eventByUid(uid);
        return json({ items: event ? [googleEvent(event)] : [] });
      }
      // events.list orderBy=startTime is ascending. Any other order is not
      // that order, so the stand-in does not pretend it is.
      const items = EVENTS.map(googleEvent);
      if (url.searchParams.get("orderBy") === "startTime") {
        items.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
      } else {
        items.reverse();
      }
      return json({ items });
    }
    const event = eventById(eventId);
    if (!event) return json({ error: "not found" }, 404);
    if (method === "PATCH") return json(googleEvent(event));
    return json(googleEvent(event));
  }

  if (url.hostname === "gmail.googleapis.com") {
    const messageId = url.pathname.match(/\/messages\/([^/]+)$/)?.[1];
    if (messageId && method === "GET") {
      const stored = MESSAGES.get(decodeURIComponent(messageId));
      if (!stored) return json({ id: messageId, payload: { headers: [] } });
      return json(gmailMessage(stored));
    }
    const threadId = url.pathname.match(/\/threads\/([^/]+)$/)?.[1];
    if (threadId && method === "GET") {
      const id = decodeURIComponent(threadId).replace(/^thr-/, "");
      const stored = MESSAGES.get(id);
      return json({
        id: threadId,
        messages: stored
          ? [{ id: stored.id, threadId: `thr-${stored.id}` }]
          : [],
      });
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      return json({ messages: [] });
    }
    if (url.pathname.endsWith("/labels") && method === "GET") {
      return json({ labels: [] });
    }
    if (method === "POST" && url.pathname.endsWith("/modify")) {
      return json({ id: "modified" });
    }
    return json({});
  }

  if (url.hostname === "graph.microsoft.com") {
    if (url.pathname.includes("/calendarView")) {
      return json({
        value: [
          {
            id: "evt-mid",
            subject: "Quarterly Board Review",
            start: { dateTime: "2026-12-02T15:00:00.0000000" },
            attendees: [
              { emailAddress: { address: BOARD_HOST } },
              { emailAddress: { address: "victim-ms@example.test" } },
            ],
            responseStatus: { response: "notResponded" },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/contacts")) return json({ value: [] });
    const graphMessage = url.pathname.match(/\/me\/messages\/([^/]+)$/);
    if (graphMessage) {
      const stored = MESSAGES.get(decodeURIComponent(graphMessage[1]));
      if (!stored) return json({ error: "not found" }, 404);
      return json({
        id: stored.id,
        conversationId: `thr-${stored.id}`,
        subject: stored.subject,
        bodyPreview: "See you there.",
        body: { contentType: "text", content: "See you there." },
        receivedDateTime: new Date().toISOString(),
        isRead: false,
        from: { emailAddress: { address: stored.from, name: "Attacker" } },
        toRecipients: [{ emailAddress: { address: "victim-ms@example.test" } }],
        internetMessageId: `<${stored.id}@example.test>`,
        hasAttachments: false,
      });
    }
    if (url.pathname.endsWith("/messages")) return json({ value: [] });
    if (url.pathname.includes("/mailFolders/")) return json({ value: [] });
    return json({ value: [] });
  }

  return json({ error: `unhandled ${method} ${urlStr}` }, 404);
}

globalThis.fetch = providerFetch as typeof fetch;

type Session = {
  accessToken: string;
  provider: "google" | "microsoft-entra-id";
  email: string;
  name: string;
  accountId: string;
};

const session: Session = {
  accessToken: TOKEN,
  provider: "google",
  email: VICTIM,
  name: "Victim",
  accountId: "acc-victim",
};

mock.module("@/lib/mail/session.ts", {
  namedExports: {
    requireMailSession: async () => session,
  },
});

const { inviteSignals, getPersonalContext } = await import(
  "../src/lib/inbox/personal-context.ts"
);
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { GET } = await import("../src/app/api/messages/[id]/route.ts");
const { POST } = await import("../src/app/api/calendar/rsvp/route.ts");
(globalThis as { React?: typeof React }).React = React;
const { AssistBar } = await import("../src/components/inbox/AssistBar.tsx");
const { useMailbox } = await import("../src/lib/inbox/use-mailbox.ts");

const EMPTY_DEBUG = {
  ruleId: "not-an-invite",
  relationship: "cold" as const,
  sentTo: 0,
  receivedFrom: 0,
  daysSinceLastSent: null,
  staleEngagement: false,
  actionable: false,
  intel: { notices: 0, schedule: 0, request: 0, followUp: 0 },
};

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  resetMutations();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${error instanceof Error ? error.stack ?? error.message : error}`,
    );
  }
}

function patches(): Rec[] {
  return rec.filter(
    (call) =>
      call.method === "PATCH" &&
      call.url.includes("/calendar/v3/calendars/primary/events/"),
  );
}

function archives(): Rec[] {
  return rec.filter(
    (call) => call.method === "POST" && call.url.includes("/modify"),
  );
}

async function readMessage(id: string): Promise<{
  status: number;
  body: {
    calendarEvent?: { id: string; subject: string; myStatus?: string };
    classification?: { action?: string; debug?: { ruleId?: string } };
  };
}> {
  const res = await GET(new Request(`http://localhost/api/messages/${id}`), {
    params: Promise.resolve({ id }),
  });
  const text = await res.text();
  let body: {
    calendarEvent?: { id: string; subject: string; myStatus?: string };
    classification?: { action?: string; debug?: { ruleId?: string } };
  } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function postRsvp(input: {
  eventId: string;
  messageId: string;
  response: "accepted" | "declined" | "tentative";
}): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const res = await POST(
    new Request("http://localhost/api/calendar/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const text = await res.text();
  let body: { ok?: boolean; error?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}

console.log("invite subject RSVP binding");

const personal = await getPersonalContext({
  accountEmail: VICTIM,
  accessToken: TOKEN,
  provider: "google",
});

{
  assert.deepEqual(
    personal.events.map((event) => event.id),
    ["evt-early", "evt-mid", "evt-late"],
  );
  assert.equal(personal.events[0]?.myStatus, "accepted");
  assert.equal(personal.events[1]?.myStatus, "needsAction");
  const listed = rec.find(
    (call) =>
      call.url.includes("/calendar/v3/calendars/primary/events?") &&
      call.url.includes("orderBy=startTime") &&
      call.url.includes("singleEvents=true"),
  );
  assert.ok(listed, "personal context must load events with orderBy=startTime");
  console.log("  ok   calendar events stay in startTime order");
}

async function grade(fromEmail: string, subject: string) {
  const id = `grade-${fromEmail}-${subject}`;
  const decisions = await classifyInboxWithAssistant(
    VICTIM,
    [
      {
        id,
        fromEmail,
        fromName: "Sender",
        subject,
        snippet: "See you there.",
        threadId: `thr-${id}`,
        receivedAt: new Date().toISOString(),
      },
    ],
    {
      accountEmail: VICTIM,
      builtAt: new Date().toISOString(),
      contacts: {},
      engagedCount: 0,
      contactCount: 0,
    },
    async () => null,
    () => ({
      action: "needs_review",
      confidence: "LOW",
      reason: "not an invite",
      debug: EMPTY_DEBUG,
    }),
    { personal, geminiEnabled: false },
  );
  const decision = decisions.get(id);
  assert.ok(decision, "grader returned no decision");
  return decision;
}

await check("a one-letter Invitation subject does not match an event", async () => {
  const decision = await grade(ATTACKER, "Invitation: q");
  assert.equal(decision.debug.ruleId, "rules:not-an-invite");
  assert.notEqual(decision.action, "act_today");
  assert.equal(inviteSignals(personal, "Invitation: q"), null);
});

await check(
  "an answered event is not treated as handled from a prefix subject",
  async () => {
    const decision = await grade(ATTACKER, "Invitation: o");
    assert.equal(decision.debug.ruleId, "rules:not-an-invite");
    assert.notEqual(decision.action, "read_and_archive");
    assert.equal(inviteSignals(personal, "Invitation: o"), null);
  },
);

await check("a longer subject is not a prefix of an event title", async () => {
  assert.equal(
    inviteSignals(personal, "Invitation: Quarterly Board Review notes"),
    null,
  );
  const decision = await grade(
    ATTACKER,
    "Invitation: Quarterly Board Review notes",
  );
  assert.equal(decision.debug.ruleId, "rules:not-an-invite");
});

await check("Updated invitation with a prefix does not match", async () => {
  assert.equal(inviteSignals(personal, "Updated invitation: q"), null);
});

await check(
  "an exact title from someone who is not the organizer is not that invite",
  async () => {
    const decision = await grade(ATTACKER, "Invitation: Quarterly Board Review");
    assert.equal(decision.debug.ruleId, "rules:not-an-invite");
    const answered = await grade(ATTACKER, "Invitation: Offsite");
    assert.equal(answered.debug.ruleId, "rules:not-an-invite");
    assert.notEqual(answered.action, "read_and_archive");
  },
);

await check(
  "an exact title from the organizer is still that invite",
  async () => {
    const unanswered = await grade(BOARD_HOST, "Invitation: Quarterly Board Review");
    assert.equal(unanswered.debug.ruleId, "invite-needs-rsvp");
    assert.equal(unanswered.action, "act_today");
    const dated = await grade(
      BOARD_HOST,
      "Invitation: Quarterly Board Review @ Thu Dec 3, 2026 9:00am",
    );
    assert.equal(dated.debug.ruleId, "invite-needs-rsvp");
    const answered = await grade(OFFSITE_HOST, "Invitation: Offsite");
    assert.equal(answered.debug.ruleId, "invite-answered");
    assert.equal(answered.action, "read_and_archive");
  },
);

remember({
  id: "msg-prefix",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: q",
});
remember({
  id: "msg-prefix-o",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: o",
});
remember({
  id: "msg-longer",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: Quarterly Board Review notes",
});
remember({
  id: "msg-updated",
  from: `Attacker <${ATTACKER}>`,
  subject: "Updated invitation: q",
});
remember({
  id: "msg-exact-attacker",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: Quarterly Board Review",
});
remember({
  id: "msg-offsite-attacker",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: Offsite",
});
remember({
  id: "msg-exact-organizer",
  from: `Board Host <${BOARD_HOST}>`,
  subject: "Invitation: Quarterly Board Review @ Thu Dec 3, 2026 9:00am",
});
remember({
  id: "msg-offsite-organizer",
  from: `Offsite Host <${OFFSITE_HOST}>`,
  subject: "Invitation: Offsite",
});
remember({
  id: "msg-ics",
  from: `Board Host <${BOARD_HOST}>`,
  subject: "Invitation: o",
  ics: ics("uid-mid"),
});
remember({
  id: "msg-bogus-ics",
  from: `Attacker <${ATTACKER}>`,
  subject: "Invitation: q",
  ics: ics("uid-does-not-exist"),
});
remember({
  id: "msg-ordinary",
  from: `Attacker <${ATTACKER}>`,
  subject: "Hello from a stranger",
});
remember({
  id: "msg-ms-prefix",
  from: ATTACKER,
  subject: "Invitation: q",
});

await check("opening a prefix subject does not offer the earliest matching event", async () => {
  const opened = await readMessage("msg-prefix");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.notEqual(opened.body.classification?.debug?.ruleId, "invite-needs-rsvp");
  assert.notEqual(opened.body.classification?.action, "act_today");
  assert.equal(
    opened.body.calendarEvent,
    undefined,
    `bound ${opened.body.calendarEvent?.id} ${opened.body.calendarEvent?.subject}`,
  );
});

await check("opening a prefix of an answered event does not show that event", async () => {
  const opened = await readMessage("msg-prefix-o");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.calendarEvent, undefined);
  assert.notEqual(opened.body.classification?.debug?.ruleId, "invite-answered");
});

await check("opening a longer or updated prefix does not bind an event", async () => {
  for (const id of ["msg-longer", "msg-updated"]) {
    const opened = await readMessage(id);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.calendarEvent, undefined, id);
  }
});

await check("opening an exact title from a non-organizer does not bind it", async () => {
  const board = await readMessage("msg-exact-attacker");
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.calendarEvent, undefined);
  const offsite = await readMessage("msg-offsite-attacker");
  assert.equal(offsite.body.calendarEvent, undefined);
});

await check("opening an exact invite from the organizer binds that event", async () => {
  const board = await readMessage("msg-exact-organizer");
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.calendarEvent?.id, "evt-mid");
  assert.equal(board.body.calendarEvent?.subject, "Quarterly Board Review");
  assert.equal(board.body.calendarEvent?.myStatus, "needsAction");
  const offsite = await readMessage("msg-offsite-organizer");
  assert.equal(offsite.body.calendarEvent?.id, "evt-early");
  assert.equal(offsite.body.calendarEvent?.myStatus, "accepted");
});

await check("a calendar part resolves its own event, not the subject prefix", async () => {
  const opened = await readMessage("msg-ics");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.calendarEvent?.id, "evt-mid");
  assert.notEqual(opened.body.calendarEvent?.id, "evt-early");
});

await check("an unresolved calendar part does not fall back to a prefix", async () => {
  const opened = await readMessage("msg-bogus-ics");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.calendarEvent, undefined);
});

await check("an ordinary subject binds no event", async () => {
  const opened = await readMessage("msg-ordinary");
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.calendarEvent, undefined);
});

await check("a Graph prefix subject does not bind a calendar event", async () => {
  session.provider = "microsoft-entra-id";
  session.email = "victim-ms@example.test";
  try {
    const opened = await readMessage("msg-ms-prefix");
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.calendarEvent, undefined);
    assert.notEqual(opened.body.classification?.debug?.ruleId, "invite-needs-rsvp");
  } finally {
    session.provider = "google";
    session.email = VICTIM;
  }
});

await check("RSVP refuses an event id resolved only by a prefix subject", async () => {
  const result = await postRsvp({
    eventId: "evt-mid",
    messageId: "msg-prefix",
    response: "accepted",
  });
  assert.deepEqual(
    {
      patches: patches().map((call) => call.url),
      archives: archives().map((call) => call.url),
    },
    { patches: [], archives: [] },
  );
  assert.notEqual(result.status, 200);
  assert.notEqual(result.body.ok, true);
});

await check("RSVP refuses an exact title that is not from the organizer", async () => {
  const result = await postRsvp({
    eventId: "evt-mid",
    messageId: "msg-exact-attacker",
    response: "accepted",
  });
  assert.deepEqual(patches().map((call) => call.url), []);
  assert.deepEqual(archives().map((call) => call.url), []);
  assert.notEqual(result.status, 200);
  const answered = await postRsvp({
    eventId: "evt-early",
    messageId: "msg-offsite-attacker",
    response: "declined",
  });
  assert.notEqual(answered.status, 200);
  assert.equal(patches().length, 0);
  assert.equal(archives().length, 0);
});

await check(
  "RSVP refuses a different event id even if a second lookup returns it",
  async () => {
    swapUidAfterFirst = true;
    const result = await postRsvp({
      eventId: "evt-late",
      messageId: "msg-ics",
      response: "accepted",
    });
    assert.deepEqual(
      patches().map((call) => call.url),
      [],
      "mismatched RSVP patched a calendar event",
    );
    assert.deepEqual(archives().map((call) => call.url), []);
    assert.notEqual(result.status, 200);
    const late = patches().some((call) => call.url.includes("evt-late"));
    assert.equal(late, false);
  },
);

await check("RSVP of the event named by the calendar part notifies and archives", async () => {
  const result = await postRsvp({
    eventId: "evt-mid",
    messageId: "msg-ics",
    response: "accepted",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(patches().length, 1);
  const patch = patches()[0];
  const url = new URL(patch.url);
  assert.equal(url.pathname.endsWith("/events/evt-mid"), true);
  assert.equal(url.searchParams.get("sendUpdates"), "all");
  const sent = JSON.parse(patch.body ?? "{}") as {
    attendees?: { self?: boolean; responseStatus?: string }[];
  };
  const mine = sent.attendees?.find((attendee) => attendee.self);
  assert.equal(mine?.responseStatus, "accepted");
  assert.equal(archives().length, 1);
  assert.match(archives()[0].url, /\/messages\/msg-ics\/modify$/);
  const archiveBody = JSON.parse(archives()[0].body ?? "{}") as {
    removeLabelIds?: string[];
  };
  assert.deepEqual(archiveBody.removeLabelIds, ["INBOX"]);
});

await check("Going on the answered card posts that event and only that event", async () => {
  const clicks: string[] = [];
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/inbox",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root: Root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        createElement(AssistBar, {
          reader: {
            htmlBody: "",
            textBody: "",
            subject: "Invitation: Quarterly Board Review",
            fromName: "Board Host",
            fromEmail: BOARD_HOST,
            toEmail: VICTIM,
            ccEmail: "",
            threadId: "thr-msg-exact-organizer",
            messageIdHeader: "<msg-exact-organizer@example.test>",
            calendarEvent: {
              id: "evt-mid",
              subject: "Quarterly Board Review",
              startsAt: "2026-12-02T15:00:00.000Z",
              myStatus: "needsAction",
            },
          },
          messageId: "msg-exact-organizer",
          onRsvp: (response) => clicks.push(response),
        }),
      );
    });
    const buttons = [...dom.window.document.querySelectorAll("button")];
    assert.deepEqual(
      buttons.map((button) => button.textContent?.replace(/\s+/g, " ").trim()),
      ["Going", "Maybe", "Can't go"],
    );
    await act(async () => {
      buttons[0]?.click();
    });
    assert.deepEqual(clicks, ["accepted"]);
  } finally {
    root.unmount();
    Object.assign(globalThis, previous);
  }
});

await check("the mailbox RSVP action does not patch a prefix-bound event", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/inbox",
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.localStorage = dom.window.localStorage;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const previousFetch = globalThis.fetch;
  const posts: { eventId?: string; messageId?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.startsWith("https://")) return providerFetch(url, init);
    if (url.startsWith("/api/messages/")) {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      return GET(new Request(`http://localhost/api/messages/${id}`), {
        params: Promise.resolve({ id }),
      });
    }
    if (url.startsWith("/api/calendar/rsvp")) {
      const raw =
        init?.body != null
          ? String(init.body)
          : input instanceof Request
            ? await input.text()
            : "{}";
      const payload = JSON.parse(raw) as { eventId?: string; messageId?: string };
      posts.push(payload);
      return POST(
        new Request("http://localhost/api/calendar/rsvp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
      );
    }
    if (method === "GET" && url.startsWith("/api/mailbox")) {
      return json({
        items: [],
        folder: "inbox",
        accountEmail: VICTIM,
        assistant: { pending: 0 },
      });
    }
    return json({ quiet: true, assistant: { pending: 0 } });
  }) as typeof fetch;

  const root = createRoot(dom.window.document.getElementById("root")!);
  const seen: { current: ReturnType<typeof useMailbox> | null } = { current: null };
  function Probe() {
    const box = useMailbox("inbox");
    seen.current = box;
    return null;
  }
  try {
    await act(async () => {
      root.render(createElement(Probe));
    });
    assert.ok(seen.current, "mailbox hook did not render");
    await act(async () => {
      await seen.current?.openReader("msg-prefix");
    });
    const reader = seen.current?.reader;
    assert.ok(
      reader,
      `reader did not open (id=${seen.current?.readerId ?? ""} toast=${seen.current?.toast ?? ""})`,
    );
    const shown = reader.calendarEvent?.id;
    await act(async () => {
      await seen.current?.rsvp("accepted");
    });
    if (shown) {
      assert.ok(
        posts.some((post) => post.eventId === shown && post.messageId === "msg-prefix"),
        "the Going action did not post the event id the reader showed",
      );
    }
    assert.equal(
      patches().length,
      0,
      `patched ${patches().map((call) => call.url).join(" ")}`,
    );
    assert.equal(archives().length, 0, "archived the attacker's message");
  } finally {
    root.unmount();
    globalThis.fetch = previousFetch;
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall invite RSVP binding tests passed");
