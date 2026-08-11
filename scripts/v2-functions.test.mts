/**
 * Gate: the whiteboard's shelves belong to the user.
 *
 * The registry is the user's org chart. A matter may only be filed under a name
 * that already exists in it, and a filing the user made themselves is a
 * decision an automatic pass must never overwrite — otherwise the next run
 * silently undoes their arrangement.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import {
  DEFAULT_FUNCTIONS,
  UNFILED,
  fileMatter,
  listFunctions,
  mattersNeedingFiling,
  seedFunctions,
} from "../src/lib/v2/intelligence/functions.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("fn@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "fn@example.com",
  });

  // Seeding is idempotent and preserves registry order.
  await seedFunctions(accountId);
  await seedFunctions(accountId);
  const functions = await listFunctions(accountId);
  assert.deepEqual(functions, DEFAULT_FUNCTIONS, "registry order is the user's own");

  const newMatter = async (title: string) => {
    const r = await db.pool.query<{ id: string }>(
      "insert into seer.matters (account_id, title) values ($1, $2) returning id",
      [accountId, title],
    );
    return r.rows[0].id;
  };

  const auto = await newMatter("Roche stability fixes");
  const mine = await newMatter("Board pack");

  // Both start unfiled and are offered to the filing pass.
  const pending = await mattersNeedingFiling(accountId, 10);
  assert.equal(pending.length, 2);

  // An automatic filing lands.
  assert.equal(await fileMatter(auto, "systems (it)", "inferred"), true);

  // The user files one themselves.
  assert.equal(await fileMatter(mine, "board", "user"), true);

  // THE CASE: a later automatic pass must not move the user's filing.
  assert.equal(
    await fileMatter(mine, "marketing", "inferred"),
    false,
    "an inferred pass must not overwrite the user's own filing",
  );

  // ...but the user can always change their mind.
  assert.equal(await fileMatter(mine, "hr", "user"), true);

  // An automatic pass may still correct its own earlier guess.
  assert.equal(await fileMatter(auto, "operations — studies", "inferred"), true);

  const filed = await db.pool.query<{
    title: string;
    function_name: string;
    function_source: string;
  }>(
    "select title, function_name, function_source from seer.matters where account_id = $1 order by title",
    [accountId],
  );
  assert.deepEqual(
    filed.rows.map((r) => `${r.title}=${r.function_name}/${r.function_source}`),
    ["Board pack=hr/user", "Roche stability fixes=operations — studies/inferred"],
  );

  // Once filed, nothing is offered to the filing pass again.
  assert.deepEqual(await mattersNeedingFiling(accountId, 10), []);

  // Work that cannot be placed rests in "unfiled" rather than being retried
  // forever or forced into a section where it would mislead.
  const odd = await newMatter("Something unplaceable");
  await fileMatter(odd, UNFILED, "inferred");
  assert.deepEqual(await mattersNeedingFiling(accountId, 10), []);

  console.log("v2-functions: ok");
} finally {
  await db.stop();
}
