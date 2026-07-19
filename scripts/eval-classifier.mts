/**
 * Offline eval: re-run classifyMessage on an exported samples JSON.
 *
 * Usage:
 *   npx tsx scripts/eval-classifier.mts fixtures/classifier/my-export.json
 *
 * Optional: set expectedAction on samples to score accuracy.
 */
import { readFileSync } from "fs";
import {
  ACTION_META,
  classifyMessage,
  type TriageAction,
} from "../src/lib/inbox/classify.ts";
import type { ClassifierExport } from "../src/lib/inbox/classifier-sample.ts";
import { buildMailHistory } from "../src/lib/inbox/mail-history.ts";

const path = process.argv[2];
if (!path) {
  console.error(
    "Usage: npx tsx scripts/eval-classifier.mts <export.json>",
  );
  process.exit(1);
}

const exported = JSON.parse(readFileSync(path, "utf8")) as ClassifierExport;

// Rebuild a thin history from export metadata + debug sent/recv counts
const contacts: Record<
  string,
  {
    email: string;
    sentTo: number;
    receivedFrom: number;
    lastSentAt?: string;
    lastReceivedAt?: string;
  }
> = {};
for (const s of exported.samples) {
  const email = s.fromEmail.toLowerCase();
  contacts[email] = {
    email,
    sentTo: s.debug.sentTo,
    receivedFrom: Math.max(s.debug.receivedFrom, 1),
    lastSentAt:
      s.debug.daysSinceLastSent != null
        ? new Date(
            Date.now() - s.debug.daysSinceLastSent * 86400000,
          ).toISOString()
        : undefined,
  };
}

const history = {
  accountEmail: exported.accountEmail.toLowerCase(),
  builtAt: exported.history.builtAt,
  contacts,
  engagedCount: exported.history.engagedCount,
  contactCount: exported.history.contactCount,
};

// unused import guard — keep buildMailHistory available for future rebuilds
void buildMailHistory;

const taught = new Map(
  exported.taughtSenders.map((t) => [t.email.toLowerCase(), t.action]),
);

let labeled = 0;
let correct = 0;
const byRule = new Map<string, number>();

console.log(
  `${"From".padEnd(28)} ${"Predicted".padEnd(16)} ${"Expected".padEnd(16)} Rule`,
);
console.log("-".repeat(90));

for (const s of exported.samples) {
  const override = taught.get(s.fromEmail.toLowerCase()) ?? null;
  const r = classifyMessage(
    {
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      subject: s.subject,
      snippet: s.snippet,
    },
    override,
    history,
  );
  byRule.set(r.debug.ruleId, (byRule.get(r.debug.ruleId) ?? 0) + 1);

  const expected = s.expectedAction as TriageAction | null | undefined;
  if (expected) {
    labeled += 1;
    if (expected === r.action) correct += 1;
  }

  console.log(
    [
      (s.fromName || s.fromDomain).slice(0, 27).padEnd(28),
      ACTION_META[r.action].short.padEnd(16),
      (expected ? ACTION_META[expected].short : "—").padEnd(16),
      r.debug.ruleId,
    ].join(""),
  );
}

console.log("-".repeat(90));
console.log(`Samples: ${exported.samples.length}`);
console.log(`History contacts: ${exported.history.contactCount} (engaged ${exported.history.engagedCount})`);
if (labeled) {
  console.log(
    `Labeled accuracy: ${correct}/${labeled} (${((100 * correct) / labeled).toFixed(1)}%)`,
  );
} else {
  console.log(
    "No expectedAction labels yet — set them in the JSON to score accuracy.",
  );
}
console.log("\nBy rule:");
for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(3)}  ${rule}`);
}
