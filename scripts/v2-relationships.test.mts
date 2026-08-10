/**
 * Gate: the relationship graph is seeded so the veto-only floor can protect
 * real humans. Merges legacy tiers, sent-history, and contacts; higher
 * relationship wins; VIP is preserved.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { collectPeople, seedPeople } from "../src/lib/v2/db/seed-relationships.ts";

// --- collectPeople merge logic ---
{
  const people = collectPeople({
    people: {
      "sandy@fund.com": { tier: "inner", vip: true, name: "Sandy" },
      "bot@no-reply.com": { tier: "machine" },
      "weak@x.com": { tier: "new-credible" },
    },
    history: { contacts: { "weak@x.com": { sentTo: 3 }, "written@y.com": { sentTo: 1 } } },
    contacts: ["saved@z.com"],
  });
  const byEmail = new Map(people.map((p) => [p.email, p]));

  assert.equal(byEmail.get("sandy@fund.com")?.tier, "inner");
  assert.equal(byEmail.get("sandy@fund.com")?.vip, true);
  // sentTo>0 upgrades new-credible -> known.
  assert.equal(byEmail.get("weak@x.com")?.tier, "known");
  assert.equal(byEmail.get("written@y.com")?.tier, "known");
  assert.equal(byEmail.get("saved@z.com")?.tier, "known");
  assert.equal(byEmail.get("bot@no-reply.com")?.tier, "machine");
}

// --- persistence + upsert ---
const db = await startTestDb();
try {
  const userId = await upsertUser("rel@example.com");
  const accountId = await upsertAccount({ userId, provider: "microsoft", email: "rel@example.com" });

  const n = await seedPeople(accountId, collectPeople({
    people: { "sandy@fund.com": { tier: "inner", vip: true } },
    history: { contacts: { "rudy@gmail.com": { sentTo: 2 } } },
    contacts: [],
  }));
  assert.equal(n, 2);

  const rows = await db.pool.query(
    "select email, tier, vip from seer.people where account_id = $1 order by email",
    [accountId],
  );
  const map = new Map(rows.rows.map((r) => [r.email, r]));
  assert.equal(map.get("sandy@fund.com")?.tier, "inner");
  assert.equal(map.get("sandy@fund.com")?.vip, true);
  assert.equal(map.get("rudy@gmail.com")?.tier, "known");

  // Re-seeding upgrades tier and never demotes VIP.
  await seedPeople(accountId, [{ email: "sandy@fund.com", tier: "known", vip: false }]);
  const after = await db.pool.query(
    "select tier, vip from seer.people where account_id = $1 and email = 'sandy@fund.com'",
    [accountId],
  );
  assert.equal(after.rows[0].vip, true, "VIP must not be lost on re-seed");

  console.log("v2-relationships: OK");
} finally {
  await db.stop();
}
