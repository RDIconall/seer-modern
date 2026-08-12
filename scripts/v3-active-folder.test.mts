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

assert.match(route, /activeSyncFolders|syncFoldersForTick/);
assert.match(
  route,
  /syncTickRoundRobin\([\s\S]*activeFolders/,
  "the route must pass the active-folder policy into the tick",
);
assert.match(
  report,
  /maxPages:\s*1/,
  "round-robin slices must keep the inbox page budget available",
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
