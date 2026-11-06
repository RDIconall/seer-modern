import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import {
  loadWhiteboardView,
  resetWhiteboardTableCache,
} from "../src/lib/v2/whiteboard/repository.ts";

const db = await startTestDb();
try {
  resetWhiteboardTableCache();
  const userId = await upsertUser("board-cmd@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "board-cmd@example.com",
  });
  const ctx = { accountId };

  const first = await loadWhiteboardView(accountId);
  assert.equal(first.persisted, true);
  assert.ok(first.sections.some((section) => section.slug === "due-now"));
  assert.ok(
    first.sections.some((section) => section.items.length > 0),
    "first load seeds the Oct 30 whiteboard",
  );

  const created = await executeCommand(
    ctx,
    {
      type: "createWhiteboardItem",
      sectionSlug: "cash-lender",
      title: "Call the lender before Friday",
    },
    "wb-create-1",
  );
  assert.equal(created.ok, true, created.error);
  const itemId = String(created.detail?.itemId);
  assert.match(itemId, /^[0-9a-f-]{36}$/);

  const replay = await executeCommand(
    ctx,
    {
      type: "createWhiteboardItem",
      sectionSlug: "cash-lender",
      title: "Call the lender before Friday",
    },
    "wb-create-1",
  );
  assert.equal(replay.replayed, true);

  const done = await executeCommand(
    ctx,
    { type: "updateWhiteboardItem", itemId, status: "done", sectionSlug: "done" },
    "wb-update-1",
  );
  assert.equal(done.ok, true, done.error);

  const view = await loadWhiteboardView(accountId);
  const item = view.sections
    .flatMap((section) => section.items)
    .find((row) => row.id === itemId);
  assert.equal(item?.status, "done");
  assert.equal(item?.sectionSlug, "done");

  console.log("v2-whiteboard-commands: OK");
} finally {
  await db.stop();
}
