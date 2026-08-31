import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { activeSyncFolders } from "../src/lib/v2/sync/report.ts";

const root = process.cwd();
const route = await fs.readFile(
  path.join(root, "src/app/api/v2/sync/route.ts"),
  "utf8",
);
const report = await fs.readFile(
  path.join(root, "src/lib/v2/sync/report.ts"),
  "utf8",
);
const fanOut = await fs.readFile(
  path.join(root, "src/lib/v2/cron/fan-out.ts"),
  "utf8",
);

assert.match(route, /activeSyncFolders/);
assert.match(
  route,
  /fanOutPerAccount/,
  "the sync cron must start one pipe per mailbox",
);
assert.match(
  route,
  /syncAccountFolders/,
  "each mailbox worker must sync its own folders under its own deadline",
);
assert.match(
  fanOut,
  /accountId/,
  "fan-out workers are addressed by account id, not a shared tick",
);
assert.match(report, /pagesPerFolder|DEFAULT_PAGES_PER_FOLDER/);

const previousFlag = process.env.SEER_V3_SYNC_ALL_FOLDERS;
delete process.env.SEER_V3_SYNC_ALL_FOLDERS;
assert.deepEqual(activeSyncFolders(), ["inbox"]);
process.env.SEER_V3_SYNC_ALL_FOLDERS = "1";
assert.deepEqual(activeSyncFolders(), ["inbox", "sent", "trash"]);
if (previousFlag === undefined) delete process.env.SEER_V3_SYNC_ALL_FOLDERS;
else process.env.SEER_V3_SYNC_ALL_FOLDERS = previousFlag;

console.log("v3-active-folder: OK");
