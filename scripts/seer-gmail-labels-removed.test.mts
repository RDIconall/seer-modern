/**
 * Decision cache must not write or read native Gmail "Seer/<action>" labels.
 * Archive/trash still use Gmail system labels (INBOX, TRASH, UNREAD).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

assert.equal(
  existsSync("src/lib/mail/seer-labels.ts"),
  false,
  "Gmail Seer label store must be deleted",
);

const FORBIDDEN = [
  "makeGmailLabelStore",
  "SeerLabelStore",
  "@/lib/mail/seer-labels",
  "labels-era:",
  "gmail-labels:",
  "Seer/${",
  'name: `${LABEL_PREFIX}',
  "decision saved as a Gmail label",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const hits: string[] = [];
for (const file of walk("src")) {
  const source = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    if (source.includes(needle)) {
      hits.push(`${file}: ${needle}`);
    }
  }
}

assert.deepEqual(hits, [], `Gmail Seer labels still referenced:\n${hits.join("\n")}`);

console.log("gmail Seer labels removed");
