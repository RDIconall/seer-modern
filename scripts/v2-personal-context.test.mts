/**
 * Microsoft Graph calendar/contacts parsing and free-slot math. Outlook is
 * Conall's primary mailbox — this must not be Google-only.
 */
import assert from "node:assert/strict";
import {
  contextSignals,
  ianaFromWindows,
  inviteAnswered,
  nextFreeSlot,
  parseGoogleEvents,
  parseGraphContacts,
  parseGraphEvents,
  type PersonalContext,
} from "../src/lib/v2/intelligence/personal-context.ts";

{
  const emails = parseGraphContacts({
    value: [
      { emailAddresses: [{ address: "Coleen@Example.com" }, { address: "ops@rditrials.com" }] },
      { emailAddresses: [] },
    ],
  });
  assert.deepEqual(emails, ["coleen@example.com", "ops@rditrials.com"]);
}

{
  const events = parseGraphEvents({
    value: [
      {
        id: "e1",
        subject: "CAP with Coleen",
        start: { dateTime: "2026-11-17T17:00:00.0000000", timeZone: "UTC" },
        attendees: [{ emailAddress: { address: "coleen@example.com" } }],
        responseStatus: { response: "accepted" },
      },
    ],
  });
  assert.equal(events[0].subject, "CAP with Coleen");
  assert.equal(events[0].myStatus, "accepted");
  assert.ok(events[0].attendees.includes("coleen@example.com"));
  assert.match(events[0].startsAt, /^2026-11-17T17:00:00/);
}

{
  const events = parseGoogleEvents({
    items: [
      {
        summary: "Standup",
        start: { dateTime: "2026-11-17T15:00:00-08:00" },
        attendees: [
          { email: "me@rditrials.com", self: true, responseStatus: "accepted" },
          { email: "coleen@example.com" },
        ],
      },
    ],
  });
  assert.equal(events[0].myStatus, "accepted");
}

assert.equal(ianaFromWindows("Pacific Standard Time"), "America/Los_Angeles");
assert.equal(ianaFromWindows("America/New_York"), "America/New_York");

{
  const ctx: PersonalContext = {
    contacts: ["coleen@example.com"],
    autoContacts: ["auto@example.com"],
    events: [
      {
        subject: "CAP with Coleen",
        startsAt: "2026-11-17T17:00:00.000Z",
        attendees: ["coleen@example.com"],
        myStatus: "accepted",
      },
    ],
    timezone: "Pacific Standard Time",
    health: { people: "ok", calendar: "ok" },
    contactsBuiltAt: null,
    eventsBuiltAt: null,
  };
  const signals = contextSignals(ctx, "coleen@example.com");
  assert.equal(signals.inContacts, true);
  assert.equal(signals.meeting?.subject, "CAP with Coleen");
  assert.equal(inviteAnswered(ctx, "Invitation: CAP with Coleen @ Tue 9am"), true);
  assert.equal(inviteAnswered(ctx, "Invitation: Mystery meeting"), false);

  const slot = nextFreeSlot(ctx, new Date("2026-11-14T17:00:00Z"));
  assert.ok(slot, "a known Outlook timezone should yield a weekday morning slot");
  assert.match(slot!, /am$/i);
}

{
  const empty: PersonalContext = {
    contacts: [],
    autoContacts: [],
    events: [],
    timezone: "Pacific Standard Time",
    health: { people: "ok", calendar: "ok" },
    contactsBuiltAt: null,
    eventsBuiltAt: null,
  };
  const slot = nextFreeSlot(empty, new Date("2026-11-14T17:00:00Z"));
  assert.ok(slot, "an empty calendar with a mailbox timezone is still free");
}

console.log("v2-personal-context: OK");
