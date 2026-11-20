/**
 * Spec for the unconfirmed-meeting reply grade.
 *
 * These tests fail while a needs-action, declined, or missing RSVP on a
 * primary-calendar event still forces a reply grade, and while a meeting
 * label still returns before the other sender and content rules. They
 * pass once a meeting counts only for an accepted or tentative response
 * and that flag cannot outrank the other rules.
 *
 * Paths covered, with the same inputs the handlers pass:
 * - single-message grading (gemini disabled): src/app/api/messages/[id]/route.ts
 * - mailbox list and Today provisional grading (deferAi, model not run):
 *   src/app/api/mailbox/route.ts, src/app/api/today/route.ts
 * - all-tasks when the model is not called: src/app/api/alltasks/route.ts
 *   shares the rules fallback. Its model prompt is not executed here.
 * - context packet: src/lib/brain/context.ts via src/app/api/cron/sync/route.ts
 *
 * Not graded with a calendar here, because those handlers never pass
 * personal context into the grader: src/app/api/brief/route.ts,
 * src/app/api/catchup/route.ts, and the triage call in
 * src/app/api/cron/sync/route.ts. The cron deep-read packet is covered
 * through compileEmailContext.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const name of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[name];
}
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "seer-unconfirmed-meeting-"),
);
// Obvious placeholder so the list path believes a model exists and still
// has to return before that model runs. Never a real credential.
process.env.GEMINI_API_KEY = "placeholder";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { compileEmailContext } = await import("../src/lib/brain/context.ts");
const { loadPeople } = await import("../src/lib/store/people.ts");
const { contextSignals, getPersonalContext } = await import(
  "../src/lib/inbox/personal-context.ts"
);

type RsvpStatus = "needsAction" | "accepted" | "declined" | "tentative";
type CalendarEventLite = {
  id?: string;
  subject: string;
  startsAt: string;
  attendees: string[];
  myStatus?: RsvpStatus;
};
type PersonalContext = {
  builtAt: string;
  eventsBuiltAt?: string;
  contacts: string[];
  autoContacts?: string[];
  events: CalendarEventLite[];
};

const ATTACKER = "alex.morgan@gmail.com";
const COLLEAGUE = "colleague@office.example";
const SOONER = "2026-11-22T15:00:00.000Z";
const LATER = "2026-11-25T15:00:00.000Z";

const PROMO = {
  fromEmail: "Alex.Morgan@gmail.com",
  fromName: "Alex Morgan",
  subject: "This week only",
  snippet: "50% off for you. Unsubscribe",
};
const ASK = {
  fromEmail: "Alex.Morgan@gmail.com",
  fromName: "Alex Morgan",
  subject: "Quick question",
  snippet: "Can you send the pricing today",
};
const FYI = {
  fromEmail: "Alex.Morgan@gmail.com",
  fromName: "Alex Morgan",
  subject: "Notes",
  snippet: "Sharing the notes from yesterday",
};
const INVITE = {
  fromEmail: "Alex.Morgan@gmail.com",
  fromName: "Alex Morgan",
  subject: "Invitation: Intro call",
  snippet: "You have been invited to Intro call",
};

type Mail = {
  fromEmail: string;
  fromName?: string;
  subject: string;
  snippet: string;
};

type Grade = {
  action: string;
  confidence: string;
  ruleId: string;
  label: string;
  source?: string;
  pending?: boolean;
};

let failures = 0;
let accounts = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
      );
    });
}

function ctx(events: CalendarEventLite[]): PersonalContext {
  return {
    builtAt: "2026-11-20T12:00:00.000Z",
    eventsBuiltAt: "2026-11-20T12:00:00.000Z",
    contacts: [],
    autoContacts: [],
    events,
  };
}

function event(
  subject: string,
  startsAt: string,
  attendees: string[],
  myStatus: RsvpStatus | undefined,
): CalendarEventLite {
  return { id: subject, subject, startsAt, attendees, myStatus };
}

function visible(result: {
  action: string;
  confidence: string;
  debug: { ruleId: string };
  source?: string;
  pending?: boolean;
  instruction?: string;
  task?: string;
}, mail: Mail): Grade {
  const guide = buildActionGuideQuick(result, mail.subject, mail.fromName, mail.snippet);
  return {
    action: result.action,
    confidence: result.confidence,
    ruleId: result.debug.ruleId,
    label: guide.label,
    source: result.source,
    pending: result.pending,
  };
}

async function grade(
  personal: PersonalContext | null,
  mail: Mail,
  mode: "open" | "list",
): Promise<Grade> {
  const account = `owner-${accounts++}@seer.test`;
  let modelCalled = false;
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    modelCalled = true;
    throw new Error("grader called the network");
  }) as typeof fetch;
  let scheduled = 0;
  try {
    const decisions = await classifyInboxWithAssistant(
      account,
      [
        {
          id: `msg-${account}`,
          fromEmail: mail.fromEmail,
          fromName: mail.fromName,
          subject: mail.subject,
          snippet: mail.snippet,
          receivedAt: "2026-11-20T13:00:00.000Z",
        },
      ],
      null,
      async () => null,
      classifyMessage,
      mode === "open"
        ? { personal, geminiEnabled: false }
        : {
            personal,
            deferAi: true,
            onDeferred: () => {
              scheduled += 1;
            },
          },
    );
    const result = decisions.get(`msg-${account}`);
    assert.ok(result, "grader returned no decision");
    assert.equal(modelCalled, false);
    if (mode === "list") assert.equal(scheduled, 1);
    if (mode === "open") assert.equal(result.pending, undefined);
    const people = await loadPeople(account);
    return {
      ...visible(result, mail),
      tier: people[ATTACKER]?.tier,
      tierReason: people[ATTACKER]?.reason,
    } as Grade & { tier?: string; tierReason?: string };
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function loadGoogle(events: unknown[]): Promise<PersonalContext> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("people.googleapis.com/v1/otherContacts")) {
      return jsonResponse({ otherContacts: [] });
    }
    if (url.includes("people.googleapis.com/v1/people/me/connections")) {
      return jsonResponse({ connections: [] });
    }
    if (url.includes("/calendar/v3/calendars/primary/events")) {
      return jsonResponse({ items: events });
    }
    throw new Error(`unexpected Google fetch ${url}`);
  }) as typeof fetch;
  try {
    return await getPersonalContext({
      accountEmail: `google-${accounts++}@seer.test`,
      accessToken: "placeholder",
      provider: "google",
    });
  } finally {
    globalThis.fetch = previous;
  }
}

async function loadGraph(events: unknown[]): Promise<PersonalContext> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("graph.microsoft.com/v1.0/me/contacts")) {
      return jsonResponse({ value: [] });
    }
    if (url.includes("graph.microsoft.com/v1.0/me/calendarView")) {
      return jsonResponse({ value: events });
    }
    throw new Error(`unexpected Graph fetch ${url}`);
  }) as typeof fetch;
  try {
    return await getPersonalContext({
      accountEmail: `graph-${accounts++}@seer.test`,
      accessToken: "placeholder",
      provider: "microsoft",
    });
  } finally {
    globalThis.fetch = previous;
  }
}

function googleEvent(
  summary: string,
  dateTime: string,
  responseStatus: string,
  guests: string[],
) {
  return {
    id: summary,
    summary,
    status: "confirmed",
    start: { dateTime },
    attendees: [
      { email: "owner@seer.test", self: true, responseStatus },
      ...guests.map((email) => ({ email, responseStatus: "accepted" })),
    ],
  };
}

function graphEvent(
  subject: string,
  dateTime: string,
  response: string,
  guests: string[],
) {
  return {
    id: subject,
    subject,
    start: { dateTime },
    attendees: guests.map((address) => ({ emailAddress: { address } })),
    responseStatus: { response },
  };
}

console.log("unconfirmed meeting reply grade");

await check("needsAction is not a meeting with that sender", () => {
  const meeting = contextSignals(
    ctx([event("Intro call", SOONER, [ATTACKER], "needsAction")]),
    ATTACKER,
  ).meeting;
  assert.equal(meeting, null);
});

await check("declined is not a meeting with that sender", () => {
  const meeting = contextSignals(
    ctx([event("Vendor pitch", SOONER, [ATTACKER], "declined")]),
    ATTACKER,
  ).meeting;
  assert.equal(meeting, null);
});

await check("a missing RSVP is not a meeting with that sender", () => {
  const meeting = contextSignals(
    ctx([event("Mystery hold", SOONER, [ATTACKER], undefined)]),
    ATTACKER,
  ).meeting;
  assert.equal(meeting, null);
});

await check("accepted still counts as a meeting", () => {
  const meeting = contextSignals(
    ctx([event("Planning", LATER, [COLLEAGUE], "accepted")]),
    COLLEAGUE,
  ).meeting;
  assert.equal(meeting?.subject, "Planning");
});

await check("tentative still counts as a meeting", () => {
  const meeting = contextSignals(
    ctx([event("Maybe sync", LATER, [COLLEAGUE], "tentative")]),
    COLLEAGUE,
  ).meeting;
  assert.equal(meeting?.subject, "Maybe sync");
});

await check(
  "an earlier declined event does not hide a later accepted one",
  () => {
    const meeting = contextSignals(
      ctx([
        event("Old pitch", SOONER, [ATTACKER], "declined"),
        event("Working session", LATER, [ATTACKER], "accepted"),
      ]),
      ATTACKER,
    ).meeting;
    assert.equal(meeting?.subject, "Working session");
  },
);

await check(
  "an earlier unanswered event does not hide a later tentative one",
  () => {
    const meeting = contextSignals(
      ctx([
        event("Unanswered hold", SOONER, [ATTACKER], "needsAction"),
        event("Maybe working session", LATER, [ATTACKER], "tentative"),
      ]),
      ATTACKER,
    ).meeting;
    assert.equal(meeting?.subject, "Maybe working session");
  },
);

await check(
  "a meeting label does not outrank a carrier status update",
  () => {
    const mail = {
      fromEmail: "tracking@ups.com",
      fromName: "UPS",
      subject: "Your package is on the way",
      snippet: "It is out for delivery",
    };
    const withMeeting = classifyMessage(mail, null, null, {
      meeting: "Intro call · in 2d",
    });
    const plain = classifyMessage(mail, null, null);
    assert.equal(withMeeting.action, plain.action);
    assert.equal(withMeeting.confidence, plain.confidence);
    assert.equal(withMeeting.debug.ruleId, plain.debug.ruleId);
    assert.equal(withMeeting.debug.ruleId, "shipper-status-delete");
    assert.equal(withMeeting.action, "delete_now");
  },
);

await check(
  "a meeting label does not outrank promotional content",
  () => {
    const withMeeting = classifyMessage(PROMO, null, null, {
      meeting: "Intro call · in 2d",
    });
    const plain = classifyMessage(PROMO, null, null);
    assert.equal(withMeeting.action, plain.action);
    assert.equal(withMeeting.confidence, plain.confidence);
    assert.equal(withMeeting.debug.ruleId, plain.debug.ruleId);
    assert.notEqual(withMeeting.action, "respond");
    assert.notEqual(withMeeting.action, "act_today");
  },
);

await check(
  "a meeting label does not turn a request preview into act today",
  () => {
    const withMeeting = classifyMessage(ASK, null, null, {
      meeting: "Intro call · in 2d",
    });
    const plain = classifyMessage(ASK, null, null);
    assert.equal(withMeeting.action, plain.action);
    assert.equal(withMeeting.confidence, plain.confidence);
    assert.equal(withMeeting.debug.ruleId, plain.debug.ruleId);
    assert.notEqual(withMeeting.debug.ruleId, "meeting-upcoming");
  },
);

await check(
  "a meeting label does not turn an ordinary note into a reply owed",
  () => {
    const withMeeting = classifyMessage(FYI, null, null, {
      meeting: "Intro call · in 2d",
    });
    const plain = classifyMessage(FYI, null, null);
    assert.equal(withMeeting.action, plain.action);
    assert.equal(withMeeting.confidence, plain.confidence);
    assert.equal(withMeeting.debug.ruleId, plain.debug.ruleId);
    assert.notEqual(withMeeting.action, "respond");
    assert.notEqual(withMeeting.action, "act_today");
  },
);

await check(
  "Google keeps an unanswered event and does not grade its sender as a reply",
  async () => {
    const personal = await loadGoogle([
      googleEvent("Intro call", SOONER, "needsAction", [
        "Alex.Morgan@gmail.com",
      ]),
      googleEvent("Vendor pitch", LATER, "declined", [
        "Alex.Morgan@gmail.com",
      ]),
      googleEvent("Planning", LATER, "accepted", [COLLEAGUE]),
      googleEvent("Maybe sync", LATER, "tentative", [COLLEAGUE]),
    ]);
    const intro = personal.events.find((e) => e.subject === "Intro call");
    const pitch = personal.events.find((e) => e.subject === "Vendor pitch");
    assert.equal(intro?.myStatus, "needsAction");
    assert.ok(intro?.attendees.includes(ATTACKER));
    assert.equal(pitch?.myStatus, "declined");
    assert.ok(pitch?.attendees.includes(ATTACKER));
    assert.equal(contextSignals(personal, ATTACKER).meeting, null);
    assert.equal(contextSignals(personal, COLLEAGUE).meeting?.subject, "Planning");

    const baseline = ctx([]);
    for (const mode of ["open", "list"] as const) {
      for (const mail of [PROMO, ASK, FYI]) {
        const forced = await grade(personal, mail, mode);
        const plain = await grade(baseline, mail, mode);
        assert.deepEqual(
          {
            action: forced.action,
            confidence: forced.confidence,
            ruleId: forced.ruleId,
            label: forced.label,
            source: forced.source,
          },
          {
            action: plain.action,
            confidence: plain.confidence,
            ruleId: plain.ruleId,
            label: plain.label,
            source: plain.source,
          },
        );
        assert.equal(forced.source, "rules");
        assert.notEqual(forced.ruleId, "rules:meeting-upcoming");
        if (mail !== ASK) {
          assert.notEqual(forced.action, "respond");
          assert.notEqual(forced.action, "act_today");
        }
        assert.notEqual(
          (forced as Grade & { tier?: string }).tier,
          "inner",
        );
      }
    }
  },
);

await check(
  "an unanswered Google invite still asks for an RSVP",
  async () => {
    const personal = await loadGoogle([
      googleEvent("Intro call", SOONER, "needsAction", [
        "Alex.Morgan@gmail.com",
      ]),
    ]);
    const graded = await grade(personal, INVITE, "open");
    assert.equal(graded.action, "act_today");
    assert.equal(graded.ruleId, "invite-needs-rsvp");
  },
);

await check(
  "a declined Google invite stays handled, and a later note is not a reply",
  async () => {
    const personal = await loadGoogle([
      googleEvent("Intro call", SOONER, "declined", ["Alex.Morgan@gmail.com"]),
    ]);
    const invite = await grade(personal, INVITE, "open");
    assert.equal(invite.action, "read_and_archive");
    assert.equal(invite.ruleId, "invite-answered");
    const note = await grade(personal, FYI, "list");
    const plain = await grade(ctx([]), FYI, "list");
    assert.equal(note.action, plain.action);
    assert.equal(note.ruleId, plain.ruleId);
    assert.notEqual(note.action, "respond");
    assert.notEqual(note.action, "act_today");
  },
);

await check(
  "Graph keeps notResponded and declined, and neither grades a reply",
  async () => {
    const personal = await loadGraph([
      graphEvent("Intro call", SOONER, "notResponded", [
        "Alex.Morgan@gmail.com",
      ]),
      graphEvent("Vendor pitch", LATER, "declined", [
        "Alex.Morgan@gmail.com",
      ]),
      graphEvent("Maybe sync", LATER, "tentativelyAccepted", [COLLEAGUE]),
    ]);
    const intro = personal.events.find((e) => e.subject === "Intro call");
    const pitch = personal.events.find((e) => e.subject === "Vendor pitch");
    const maybe = personal.events.find((e) => e.subject === "Maybe sync");
    assert.equal(intro?.myStatus, "needsAction");
    assert.ok(intro?.attendees.includes(ATTACKER));
    assert.equal(pitch?.myStatus, "declined");
    assert.equal(maybe?.myStatus, "tentative");
    assert.equal(contextSignals(personal, ATTACKER).meeting, null);
    assert.equal(
      contextSignals(personal, COLLEAGUE).meeting?.subject,
      "Maybe sync",
    );

    const forced = await grade(personal, PROMO, "open");
    const plain = await grade(ctx([]), PROMO, "open");
    assert.equal(forced.action, plain.action);
    assert.equal(forced.confidence, plain.confidence);
    assert.equal(forced.ruleId, plain.ruleId);
    assert.equal(forced.source, "rules");
    assert.notEqual(forced.action, "respond");
    assert.notEqual(forced.action, "act_today");

    const listed = await grade(personal, ASK, "list");
    const listedPlain = await grade(ctx([]), ASK, "list");
    assert.equal(listed.action, listedPlain.action);
    assert.equal(listed.confidence, listedPlain.confidence);
    assert.equal(listed.ruleId, listedPlain.ruleId);
    assert.notEqual(listed.ruleId, "rules:meeting-upcoming");
  },
);

await check(
  "the context packet does not cite an unconfirmed or declined meeting",
  () => {
    const sources = {
      accountEmail: "owner@seer.test",
      ownDomain: "seer.test",
    };
    const unanswered = compileEmailContext(PROMO, {
      ...sources,
      personal: ctx([event("Intro call", SOONER, [ATTACKER], "needsAction")]),
    });
    const declined = compileEmailContext(PROMO, {
      ...sources,
      personal: ctx([event("Vendor pitch", SOONER, [ATTACKER], "declined")]),
    });
    const accepted = compileEmailContext(
      { ...PROMO, fromEmail: COLLEAGUE },
      {
        ...sources,
        personal: ctx([event("Planning", LATER, [COLLEAGUE], "accepted")]),
      },
    );
    assert.equal(unanswered.text.includes("MEETING:"), false);
    assert.equal(declined.text.includes("MEETING:"), false);
    assert.equal(accepted.text.includes("MEETING:"), true);
    assert.equal(accepted.text.includes("Planning"), true);
  },
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
