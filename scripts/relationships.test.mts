import assert from "node:assert/strict";
import { knownSenders } from "../src/lib/brain/relationships.ts";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

console.log("relationships");

check("someone you have emailed is a known sender", () => {
  const known = knownSenders({
    history: {
      builtAt: "",
      contacts: {
        "anna@roche.com": { email: "anna@roche.com", sentTo: 4, receivedFrom: 9 },
      },
      repliedThreads: {},
    },
  });
  assert.ok(known.has("anna@roche.com"));
});

check("a saved contact is a known sender, case-insensitively", () => {
  const known = knownSenders({
    personal: {
      builtAt: "2026-08-09",
      contacts: ["Phillip@BizDevLabs.ca"],
      events: [],
    },
  });
  assert.ok(known.has("phillip@bizdevlabs.ca"));
});

check("a VIP and an inner/known tier person are known senders", () => {
  const known = knownSenders({
    people: {
      "board@fund.com": {
        email: "board@fund.com",
        tier: "known",
        by: "ai",
        vip: true,
      },
      "colleague@rditrials.com": {
        email: "colleague@rditrials.com",
        tier: "inner",
        by: "user",
      },
    },
  });
  assert.ok(known.has("board@fund.com"));
  assert.ok(known.has("colleague@rditrials.com"));
});

check("machines and strangers are NOT known senders", () => {
  const known = knownSenders({
    people: {
      "noreply@slack.com": {
        email: "noreply@slack.com",
        tier: "machine",
        by: "ai",
      },
      "first@cold-outreach.io": {
        email: "first@cold-outreach.io",
        tier: "new-credible",
        by: "ai",
      },
    },
    history: {
      builtAt: "",
      contacts: {
        "bulk@newsletter.com": {
          email: "bulk@newsletter.com",
          sentTo: 0,
          receivedFrom: 40,
        },
      },
      repliedThreads: {},
    },
  });
  assert.equal(known.has("noreply@slack.com"), false);
  assert.equal(known.has("first@cold-outreach.io"), false);
  assert.equal(known.has("bulk@newsletter.com"), false);
});

check("empty sources produce an empty set, never a throw", () => {
  const known = knownSenders({});
  assert.equal(known.size, 0);
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
