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

// The core surfaces exist. Triage is no longer a standalone screen — the inbox
// list owns bulk delete — so MailApp/Triage must not linger as dead hosts.
for (const required of [
  "Atlas.tsx",
  "WorthReading.tsx",
  "useInboxView.ts",
  "triage-select.ts",
  "triage-command.ts",
]) {
  assert.ok(files.includes(required), `missing v2 component ${required}`);
}
assert.ok(!files.includes("Triage.tsx"), "standalone Triage screen must be removed");
assert.ok(!files.includes("MailApp.tsx"), "dead MailApp host must be removed");

// Inbox delete is authorised solely by the server-minted token.
const folderList = await fs.readFile(
  path.join(process.cwd(), "src", "components", "v3", "FolderList.tsx"),
  "utf8",
);
assert.ok(
  folderList.includes("deleteToken"),
  "FolderList must use the server delete token",
);
assert.ok(
  /deletableCount|commandsForSelection/.test(folderList),
  "FolderList must gate bulk delete through the shared selection helpers",
);
// Categories come from the server row, not a client-side org/domain guess.
assert.ok(
  folderList.includes("row.category"),
  "FolderList must show the server-provided category",
);
assert.ok(
  !/counterpartyOf|split\(["']@["']\)/.test(folderList),
  "FolderList must not re-derive the category from the sender",
);

// The flag wires the single app into both entry points.
for (const page of ["src/app/page.tsx", "src/app/m/page.tsx"]) {
  const src = await fs.readFile(path.join(process.cwd(), page), "utf8");
  assert.ok(src.includes("isV2Enabled"), `${page} must gate on isV2Enabled`);
  assert.ok(src.includes("MailClient"), `${page} must render the v3 MailClient`);
}

console.log("v2-ui-contract: OK");
