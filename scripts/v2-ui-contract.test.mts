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
for (const required of ["triage-select.ts", "triage-command.ts"]) {
  assert.ok(files.includes(required), `missing v2 component ${required}`);
}
// The Inbox is the whole app: the Atlas board, the Worth reading list and the
// delegated-staff pane were collapsed into it and must not linger as dead UI.
for (const gone of [
  "Atlas.tsx",
  "WorthReading.tsx",
  "StaffBoard.tsx",
  "StaffPane.tsx",
  "useStaffView.ts",
  "useInboxView.ts",
]) {
  assert.ok(!files.includes(gone), `${gone} was collapsed into the Inbox and must stay removed`);
}
assert.ok(!files.includes("Triage.tsx"), "standalone Triage screen must be removed");
assert.ok(!files.includes("MailApp.tsx"), "dead MailApp host must be removed");

/**
 * Two ways to delete, and they must not be confused.
 *
 * A sweep is Seer emptying a pile nobody read row by row, so it may only take
 * what the server signed a token for. A selection is the user pointing at mail
 * they picked out themselves, so it takes what they pointed at. Seer's
 * judgement constrains Seer; it does not lock the user out of their own mailbox.
 * The Inbox's "Do these next steps" is the second kind: the person ticked each
 * group and confirmed the list, so its deletes are theirs.
 */
const read = (file: string) =>
  fs.readFile(path.join(process.cwd(), "src", "components", ...file.split("/")), "utf8");
const folderList = await read("v3/FolderList.tsx");
assert.ok(
  folderList.includes("commandsForSelection"),
  "a user selection must go through the shared selection helper",
);
assert.ok(
  !folderList.includes("sweepCommands"),
  "folders have no pile sweeps; the Inbox asks before it acts",
);
const triageCommand = await read("v2/triage-command.ts");
assert.ok(
  /commandFor[\s\S]*?row\.deleteToken/.test(triageCommand),
  "the sweep path must still require the server-minted token",
);
assert.ok(
  /userCommandFor[\s\S]*?byUser: true/.test(triageCommand),
  "an explicit user delete must be marked as theirs",
);
const bulkPlan = await read("v3/bulk-plan.ts");
assert.ok(
  /type: "delete"[\s\S]*?byUser: true/.test(bulkPlan),
  "a confirmed bulk delete is the person's own delete",
);
// Categories come from the server row, not a client-side org/domain guess.
const inboxGroups = await read("v3/inbox-groups.ts");
assert.ok(
  inboxGroups.includes("newest.category"),
  "the Inbox must show the server-provided category",
);
for (const src of [folderList, inboxGroups]) {
  assert.ok(
    !/counterpartyOf|split\(["']@["']\)/.test(src),
    "the lists must not re-derive the category from the sender",
  );
}

// The flag wires the single app into both entry points.
for (const page of ["src/app/page.tsx", "src/app/m/page.tsx"]) {
  const src = await fs.readFile(path.join(process.cwd(), page), "utf8");
  assert.ok(src.includes("isV2Enabled"), `${page} must gate on isV2Enabled`);
  assert.ok(src.includes("MailClient"), `${page} must render the v3 MailClient`);
}

console.log("v2-ui-contract: OK");
