/**
 * Session write routes, including V3-reachable /api/assist/draft, must share
 * the same origin/CSRF helper as the v2 command bus.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, "../src/app/api");

const SESSION_WRITES = [
  "assist/draft/route.ts",
  "action/route.ts",
  "action/bulk/route.ts",
  "send/route.ts",
  "archive/route.ts",
  "delete/route.ts",
  "correct/route.ts",
  "profile/route.ts",
  "imessage/route.ts",
  "vips/route.ts",
  "triage/clear/route.ts",
  "triage/undo/route.ts",
  "calendar/rsvp/route.ts",
  "calendar/schedule/route.ts",
  "delegate/route.ts",
  "ea/route.ts",
  "matters/route.ts",
  "salesforce/route.ts",
  "unsubscribe/route.ts",
  "reclassify/route.ts",
  "brief/route.ts",
  "accounts/route.ts",
];

for (const rel of SESSION_WRITES) {
  const source = readFileSync(path.join(API, rel), "utf8");
  assert.match(
    source,
    /requestOriginAllowed|originAllowed/,
    `${rel} must check request origin`,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const skipped = [
  "/webhooks/",
  "/cron/",
  "/auth/",
  "/v2/sync/",
  "/v2/read/",
  "/v2/shadow/",
  "/v2/bakeoff/",
  "/v2/accounts/",
  "/salesforce/callback/",
  "/salesforce/connect/",
  "/nlp/classify/",
];
for (const file of walk(API)) {
  const rel = file.slice(API.length);
  const source = readFileSync(file, "utf8");
  const hasWrite = /export async function (POST|PATCH|PUT|DELETE)/.test(source);
  if (!hasWrite) continue;
  if (skipped.some((part) => rel.includes(part))) continue;
  assert.match(
    source,
    /requestOriginAllowed|originAllowed/,
    `${rel} is a session write without an origin check`,
  );
}

const draft = readFileSync(path.join(API, "assist/draft/route.ts"), "utf8");
assert.match(draft, /requestOriginAllowed/, "V3 still uses /api/assist/draft");

console.log("v3-legacy-origin: OK");
