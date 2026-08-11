/**
 * Task 1 gate: the committed migrations produce the full v2 relational model
 * in the private `seer` schema, with RLS enabled on every account-scoped
 * table. Runs against a throwaway embedded Postgres.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";

const EXPECTED_TABLES = [
  "users",
  "mail_accounts",
  "oauth_credentials",
  "conversations",
  "messages",
  "people",
  "relationship_evidence",
  "matters",
  "matter_codes",
  "matter_conversations",
  "conversation_decisions",
  "decision_evidence",
  "yields",
  "interest_signals",
  "events",
  "command_receipts",
  "sync_state",
  "sync_runs",
  "model_usage",
  "functions",
  "folder_sync_state",
  "outbox",
].sort();

const RLS_TABLES = [
  "users",
  "mail_accounts",
  "oauth_credentials",
  "conversations",
  "messages",
  "people",
  "matters",
  "conversation_decisions",
  "yields",
  "events",
  "model_usage",
  "functions",
  "folder_sync_state",
  "outbox",
];

const db = await startTestDb();
try {
  const tables = await db.pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'seer' order by table_name",
  );
  assert.deepEqual(
    tables.rows.map((r) => r.table_name).sort(),
    EXPECTED_TABLES,
    "seer schema must contain exactly the v2 core tables",
  );

  const rls = await db.pool.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer' and c.relkind = 'r'`,
  );
  const rlsByName = new Map(rls.rows.map((r) => [r.relname, r.relrowsecurity]));
  for (const t of RLS_TABLES) {
    assert.equal(rlsByName.get(t), true, `RLS must be enabled on seer.${t}`);
  }

  // The current-decision partial unique index is the guarantee that a
  // conversation has exactly one live home.
  const idx = await db.pool.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'seer' and indexname = 'conversation_decisions_current_idx'",
  );
  assert.equal(idx.rowCount, 1, "one-current-decision index must exist");

  console.log("v2-schema: OK");
} finally {
  await db.stop();
}
