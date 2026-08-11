/**
 * Task 1 gate: v3 folder-aware corpus columns, per-folder sync cursors, and the
 * durable mutation outbox. Runs against the same embedded Postgres as v2.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";

/** Provider-neutral folder ids stored on conversations and sync state. */
const MAIL_FOLDERS = ["inbox", "sent", "trash", "archive"] as const;
const SYNC_FOLDERS = ["inbox", "sent", "trash"] as const;
const OUTBOX_STATUSES = ["pending", "inflight", "done", "failed", "cancelled"] as const;

const db = await startTestDb();
try {
  // -------------------------------------------------------------------------
  // conversations: folder membership, unread rollup, reconciliation timestamp
  // -------------------------------------------------------------------------
  const convCols = await db.pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'seer'
        and table_name = 'conversations'
        and column_name in ('folders', 'is_unread', 'last_synced_at')
      order by column_name`,
  );
  assert.equal(convCols.rowCount, 3, "conversations must gain folders, is_unread, last_synced_at");

  const col = (name: string) => convCols.rows.find((r) => r.column_name === name)!;
  assert.equal(col("folders").data_type, "ARRAY", "folders is text[]");
  assert.equal(col("folders").is_nullable, "NO", "folders is not null");
  assert.match(col("folders").column_default ?? "", /'{}'/);
  assert.equal(col("is_unread").data_type, "boolean", "is_unread is boolean");
  assert.equal(col("is_unread").is_nullable, "NO", "is_unread is not null");
  assert.match(col("is_unread").column_default ?? "", /false/i);
  assert.equal(col("last_synced_at").data_type, "timestamp with time zone", "last_synced_at is timestamptz");
  assert.equal(col("last_synced_at").is_nullable, "YES", "last_synced_at is nullable");

  void MAIL_FOLDERS; // archive is corpus-only; sync cursors cover inbox/sent/trash.

  // -------------------------------------------------------------------------
  // folder_sync_state: one cursor row per account × sync folder
  // -------------------------------------------------------------------------
  const fss = await db.pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'seer' and table_name = 'folder_sync_state'`,
  );
  assert.equal(fss.rowCount, 1, "seer.folder_sync_state must exist");

  const fssCols = await db.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'seer' and table_name = 'folder_sync_state'
      order by ordinal_position`,
  );
  assert.deepEqual(
    fssCols.rows.map((r) => r.column_name),
    ["account_id", "folder", "cursor", "provider_total", "updated_at"],
    "folder_sync_state columns",
  );

  const fssPk = await db.pool.query<{ constraint_name: string }>(
    `select constraint_name from information_schema.table_constraints
      where table_schema = 'seer' and table_name = 'folder_sync_state'
        and constraint_type = 'PRIMARY KEY'`,
  );
  assert.equal(fssPk.rowCount, 1, "folder_sync_state primary key on (account_id, folder)");

  const fssFolderCheck = await db.pool.query<{ conname: string; definition: string }>(
    `select c.conname, pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'seer'
        and t.relname = 'folder_sync_state'
        and c.contype = 'c'`,
  );
  assert.ok(
    fssFolderCheck.rows.some((r) => {
      const def = r.definition.toLowerCase();
      return (
        def.includes("folder") &&
        def.includes("inbox") &&
        def.includes("sent") &&
        def.includes("trash")
      );
    }),
    "folder_sync_state.folder must be inbox|sent|trash",
  );
  void SYNC_FOLDERS;

  // -------------------------------------------------------------------------
  // outbox: durable write-behind queue with idempotency and retry state
  // -------------------------------------------------------------------------
  const outbox = await db.pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'seer' and table_name = 'outbox'`,
  );
  assert.equal(outbox.rowCount, 1, "seer.outbox must exist");

  const outboxCols = await db.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'seer' and table_name = 'outbox'
      order by ordinal_position`,
  );
  assert.deepEqual(
    outboxCols.rows.map((r) => r.column_name),
    [
      "id",
      "account_id",
      "command",
      "idempotency_key",
      "status",
      "attempts",
      "last_error",
      "next_attempt_at",
      "created_at",
      "updated_at",
    ],
    "outbox columns",
  );

  const outboxUnique = await db.pool.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'seer' and tablename = 'outbox'
        and indexdef ilike '%unique%' and indexdef ilike '%idempotency_key%'`,
  );
  assert.ok(outboxUnique.rowCount >= 1, "outbox.idempotency_key must be unique");

  const outboxStatusCheck = await db.pool.query<{ definition: string }>(
    `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'seer'
        and t.relname = 'outbox'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ilike '%status%'`,
  );
  assert.ok(
    outboxStatusCheck.rows.some((r) =>
      OUTBOX_STATUSES.every((s) => r.definition.includes(`'${s}'`)),
    ),
    "outbox.status must allow pending|inflight|done|failed|cancelled",
  );

  // -------------------------------------------------------------------------
  // Indexes for mailbox folder lists and outbox drain
  // -------------------------------------------------------------------------
  const indexes = await db.pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'seer' order by indexname`,
  );
  const indexNames = new Set(indexes.rows.map((r) => r.indexname));
  assert.ok(
    indexNames.has("conversations_account_folders_idx"),
    "GIN index on conversations.folders for folder membership queries",
  );
  assert.ok(
    indexNames.has("outbox_account_pending_idx"),
    "partial index for pending outbox drain ordered by next_attempt_at",
  );

  // -------------------------------------------------------------------------
  // RLS + seer_app grants on the new account-scoped tables
  // -------------------------------------------------------------------------
  const rls = await db.pool.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer'
        and c.relkind = 'r'
        and c.relname in ('folder_sync_state', 'outbox')`,
  );
  for (const t of ["folder_sync_state", "outbox"]) {
    assert.equal(rls.rows.find((r) => r.relname === t)?.relrowsecurity, true, `RLS on seer.${t}`);
  }

  const role = await db.pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = 'seer_app') as exists",
  );
  assert.equal(role.rows[0].exists, true, "seer_app role must exist for least-privilege grants");

  for (const table of ["folder_sync_state", "outbox"]) {
    const grants = await db.pool.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where grantee = 'seer_app'
          and table_schema = 'seer'
          and table_name = $1`,
      [table],
    );
    const privs = new Set(grants.rows.map((r) => r.privilege_type));
    for (const need of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      assert.ok(privs.has(need), `seer_app must have ${need} on seer.${table}`);
    }
  }

  const policies = await db.pool.query<{ tablename: string; policyname: string; roles: string[] }>(
    `select tablename, policyname, roles
       from pg_policies
      where schemaname = 'seer'
        and tablename in ('folder_sync_state', 'outbox')
        and 'seer_app' = any(roles)`,
  );
  assert.equal(
    policies.rowCount,
    2,
    "each new table needs an explicit seer_app RLS policy",
  );

  console.log("v3-schema: OK");
} finally {
  await db.stop();
}
