/**
 * Spec for the public chief-of-staff seed fixture.
 *
 * scripts/seed-bot-tasks.mts reads fixtures/bot_tasks.csv and tasksFromCsv
 * keeps the task text it will store. Those notes are tracked in this public
 * repository. This test fails while a tracked file still has a payment-card
 * ending, a payroll-system license audit, or a counted license quantity.
 * It passes once that text is gone from the tree the product ships.
 *
 * The dev preview sample (src/app/dev/preview/v3-sample.ts) is a separate
 * shortened copy with none of those three patterns, so it is not covered here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasksFromCsv } from "../src/lib/v2/staff/seed.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same default the seed script builds in scripts/seed-bot-tasks.mts. */
const SEED_CSV = path.join(
  path.dirname(fileURLToPath(new URL("./seed-bot-tasks.mts", import.meta.url))),
  "..",
  "fixtures",
  "bot_tasks.csv",
);

const CARD_ENDING =
  /\b(?:cards?|boa)\b[^0-9\n]{0,40}(?!\d{4}-\d{2}-\d{2})\d{4}\b/i;
const PAYROLL_SYSTEM = /gusto/i;
const LICENSE_WORD = /licen[cs]e/i;
const COUNTED_LICENSES = /\b\d+\s+licen[cs]es?\b/i;

function trackedTextFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed.split("\0").filter((rel) => rel.length > 0);
}

function lineViolations(rel: string, line: string): string[] {
  const found: string[] = [];
  if (CARD_ENDING.test(line)) {
    found.push(`${rel}: payment-card ending`);
  }
  if (PAYROLL_SYSTEM.test(line) && LICENSE_WORD.test(line)) {
    found.push(`${rel}: payroll-system license audit`);
  }
  if (COUNTED_LICENSES.test(line)) {
    found.push(`${rel}: counted license quantity`);
  }
  return found;
}

const violations: string[] = [];

for (const rel of trackedTextFiles()) {
  const absolute = path.join(ROOT, rel);
  const bytes = await fs.readFile(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    for (const violation of lineViolations(rel, line)) {
      if (!violations.includes(violation)) violations.push(violation);
    }
  }
}

try {
  const csv = await fs.readFile(SEED_CSV, "utf8");
  for (const task of tasksFromCsv(csv)) {
    const stored = [
      task.title,
      task.hisWords,
      task.currentState,
      task.nextAction,
    ].join("\n");
    if (CARD_ENDING.test(stored)) {
      violations.push(
        `${task.externalKey}: payment-card ending survived tasksFromCsv`,
      );
    }
    if (PAYROLL_SYSTEM.test(stored) && LICENSE_WORD.test(stored)) {
      violations.push(
        `${task.externalKey}: payroll-system license audit survived tasksFromCsv`,
      );
    }
    if (COUNTED_LICENSES.test(stored)) {
      violations.push(
        `${task.externalKey}: counted license quantity survived tasksFromCsv`,
      );
    }
  }
} catch (cause) {
  const code = (cause as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw cause;
}

assert.deepEqual(
  violations,
  [],
  "tracked seed text still exposes payment or payroll details",
);

console.log("bot-tasks-fixture-exposure: OK");
