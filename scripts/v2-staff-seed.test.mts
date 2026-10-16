import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  inferOpenTaskStatus,
  parseCsv,
  slugifyBotName,
  tasksFromCsv,
} from "../src/lib/v2/staff/seed.ts";

assert.equal(slugifyBotName("Chief of staff"), "chief-of-staff");
assert.equal(slugifyBotName("Personal Chief of Staff"), "personal-chief-of-staff");
assert.equal(slugifyBotName("SnaK-Bot"), "snak-bot");
assert.equal(slugifyBotName("Proposals & Bids"), "proposals-bids");

assert.equal(
  inferOpenTaskStatus("Not started. Stuck at sign-in: Conall uses a separate login."),
  "waiting_on_user",
);
assert.equal(
  inferOpenTaskStatus("Blocked: Vercel connector lacks rditrials team access."),
  "blocked",
);
assert.equal(
  inferOpenTaskStatus("Running as a daily 7:32 AM dry run; nothing moved yet"),
  "in_progress",
);
assert.equal(
  inferOpenTaskStatus("No action taken (dropped)"),
  "open",
);

const parsed = parseCsv('id,task\nB01,"Save ""Files"", please"\n');
assert.deepEqual(parsed[1], ["B01", 'Save "Files", please']);

const csv = await fs.readFile(
  path.join(process.cwd(), "fixtures", "bot_tasks.csv"),
  "utf8",
);
const tasks = tasksFromCsv(csv);
assert.equal(tasks.length, 27, "CSV seed is the 27 open tasks");
assert.equal(tasks[0].externalKey, "B01");
assert.equal(tasks[0].botSlug, "chief-of-staff");
assert.match(tasks[0].hisWords, /divvy/i);
assert.ok(tasks.every((task) => task.status !== "done"));
assert.ok(tasks.every((task) => task.status !== "dropped"));
assert.ok(tasks.some((task) => task.botSlug === "snak-bot"));
assert.ok(tasks.some((task) => task.botSlug === "it-admin"));

console.log("v2-staff-seed: OK");
