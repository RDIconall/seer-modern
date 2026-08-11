/**
 * Task 12 gate: the v2 UI is render-only. No component re-derives placement,
 * buckets by disposition, encodes relationship rules, or branches on provider.
 * The single responsive app is wired behind the allowlist flag.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "src", "components", "v2");
const files = (await fs.readdir(dir)).filter(
  (f) => f.endsWith(".tsx") || f.endsWith(".ts"),
);

const forbidden: [RegExp, string][] = [
  [/DELETE_DISPOSITIONS/, "client-side delete disposition set"],
  [/\bdisposition\b/i, "disposition re-interpretation"],
  [/=== *['"]google['"]/, "provider branch on google"],
  [/=== *['"]microsoft['"]/, "provider branch on microsoft"],
  [/knownSenders|relationship floor/i, "relationship policy in UI"],
];

for (const file of files) {
  const src = await fs.readFile(path.join(dir, file), "utf8");
  for (const [pattern, why] of forbidden) {
    assert.ok(!pattern.test(src), `${file} must not contain ${why} (${pattern})`);
  }
}

// The core surfaces exist.
for (const required of [
  "MailApp.tsx",
  "Atlas.tsx",
  "Triage.tsx",
  "WorthReading.tsx",
  "useInboxView.ts",
]) {
  assert.ok(files.includes(required), `missing v2 component ${required}`);
}

// Triage renders delete rows from the server token, not a computed bucket.
const triage = await fs.readFile(path.join(dir, "Triage.tsx"), "utf8");
assert.ok(triage.includes("deleteToken"), "Triage must use the server delete token");
assert.ok(
  triage.includes("view.safeToDelete"),
  "Triage must render the server-computed safeToDelete rows",
);
// Categories come from the server row, not a client-side org/domain guess.
assert.ok(
  triage.includes("row.category") || triage.includes(".category"),
  "Triage must group by the server-provided category",
);
assert.ok(
  !/counterpartyOf|split\(["']@["']\)/.test(triage),
  "Triage must not re-derive the category from the sender",
);

// The flag wires the single app into both entry points.
for (const page of ["src/app/page.tsx", "src/app/m/page.tsx"]) {
  const src = await fs.readFile(path.join(process.cwd(), page), "utf8");
  assert.ok(src.includes("isV2Enabled"), `${page} must gate on isV2Enabled`);
  assert.ok(src.includes("MailApp"), `${page} must render the v2 MailApp`);
}

console.log("v2-ui-contract: OK");
