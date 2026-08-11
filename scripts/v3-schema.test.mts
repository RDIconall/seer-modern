/**
 * Task 1 gate: v3 folder-aware corpus columns, per-folder sync cursors, and the
 * durable mutation outbox. Runs against the same embedded Postgres as v2.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";

const SYNC_FOLDERS = ["inbox", "sent", "trash"] as const;
const OUTBOX_STATUSES = ["pending", "inflight", "done", "failed", "cancelled"] as const;
const CORE_TABLES = [
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
  "folder_sync_seen",
  "outbox",
] as const;

async function indexDef(
  pool: Awaited<ReturnType<typeof startTestDb>>["pool"],
  name: string,
): Promise<{ indexdef: string; method: string }> {
  const r = await pool.query<{ indexdef: string; method: string }>(
    `select pg_get_indexdef(i.oid) as indexdef, am.amname as method
       from pg_class i
       join pg_namespace n on n.oid = i.relnamespace
       join pg_am am on am.oid = i.relam
      where n.nspname = 'seer'
        and i.relkind = 'i'
        and i.relname = $1`,
    [name],
  );
  assert.equal(r.rowCount, 1, `index ${name} must exist`);
  return r.rows[0];
}

async function pkColumns(
  pool: Awaited<ReturnType<typeof startTestDb>>["pool"],
  table: string,
): Promise<string[]> {
  const r = await pool.query<{ attname: string; ord: number }>(
    `select a.attname, array_position(i.indkey, a.attnum) as ord
       from pg_index i
       join pg_class t on t.oid = i.indrelid
       join pg_namespace n on n.oid = t.relnamespace
       join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
      where n.nspname = 'seer'
        and t.relname = $1
        and i.indisprimary
      order by ord`,
    [table],
  );
  return r.rows.map((row) => row.attname);
}

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
    [
      "account_id",
      "folder",
      "cursor",
      "provider_total",
      "updated_at",
      "backfill_complete",
      "scan_generation",
      "scan_started_at",
      "last_reconciled_at",
    ],
    "folder_sync_state columns",
  );

  assert.deepEqual(
    await pkColumns(db.pool, "folder_sync_state"),
    ["account_id", "folder"],
    "folder_sync_state PK must be exactly (account_id, folder)",
  );

  const fssFolderCheck = await db.pool.query<{ definition: string }>(
    `select pg_get_constraintdef(c.oid) as definition
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
      return SYNC_FOLDERS.every((f) => def.includes(`'${f}'`));
    }),
    "folder_sync_state.folder must be inbox|sent|trash",
  );

  const seen = await db.pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'seer' and table_name = 'folder_sync_seen'`,
  );
  assert.equal(seen.rowCount, 1, "seer.folder_sync_seen must exist");
  assert.deepEqual(
    await pkColumns(db.pool, "folder_sync_seen"),
    ["account_id", "folder", "scan_generation", "provider_conversation_id"],
    "folder_sync_seen PK must identify one provider conversation in one scan",
  );

  const user = await db.pool.query<{ id: string }>(
    "insert into seer.users (email) values ('v3-schema@test.local') returning id",
  );
  const account = await db.pool.query<{ id: string }>(
    `insert into seer.mail_accounts (user_id, provider, email)
     values ($1, 'google', 'v3-schema@test.local') returning id`,
    [user.rows[0].id],
  );
  const accountId = account.rows[0].id;

  await assert.rejects(
    () =>
      db.pool.query(
        `insert into seer.folder_sync_state (account_id, folder)
         values ($1, 'archive')`,
        [accountId],
      ),
    /check constraint|violates check constraint/i,
    "folder_sync_state must reject archive (corpus-only folder)",
  );

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
      "reconcile_needed",
      "next_attempt_at",
      "created_at",
      "updated_at",
    ],
    "outbox columns",
  );

  const reconcileCol = await db.pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'seer'
        and table_name = 'outbox'
        and column_name = 'reconcile_needed'`,
  );
  assert.equal(reconcileCol.rowCount, 1, "outbox must have reconcile_needed");
  assert.equal(reconcileCol.rows[0].data_type, "boolean");
  assert.equal(reconcileCol.rows[0].is_nullable, "NO");
  assert.match(reconcileCol.rows[0].column_default ?? "", /false/i);

  const outboxUnique = await indexDef(db.pool, "outbox_account_id_idempotency_key_key");
  assert.match(
    outboxUnique.indexdef,
    /unique.*\(account_id,\s*idempotency_key\)/i,
    "outbox idempotency must be scoped to (account_id, idempotency_key)",
  );

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

  // Same idempotency key on two accounts must both succeed.
  const other = await db.pool.query<{ id: string }>(
    `insert into seer.mail_accounts (user_id, provider, email)
     values ($1, 'google', 'v3-schema-other@test.local') returning id`,
    [user.rows[0].id],
  );
  await db.pool.query(
    `insert into seer.outbox (account_id, command, idempotency_key)
     values ($1, '{"type":"archive"}', 'shared-key'), ($2, '{"type":"archive"}', 'shared-key')`,
    [accountId, other.rows[0].id],
  );

  // -------------------------------------------------------------------------
  // Indexes for mailbox folder lists and outbox drain
  // -------------------------------------------------------------------------
  const accountIdx = await indexDef(db.pool, "conversations_account_folders_account_idx");
  assert.match(
    accountIdx.indexdef,
    /\(account_id\)/i,
    "account btree index must cover account_id",
  );
  assert.equal(accountIdx.method, "btree", "account index must use btree");

  const foldersGin = await indexDef(db.pool, "conversations_account_folders_gin_idx");
  assert.match(foldersGin.indexdef, /\(folders\)/i, "folders GIN index must cover folders");
  assert.equal(foldersGin.method, "gin", "folders index must use GIN");

  const pendingIdx = await indexDef(db.pool, "outbox_account_pending_idx");
  assert.match(
    pendingIdx.indexdef,
    /\(account_id,\s*next_attempt_at\)/i,
    "pending drain index must order by next_attempt_at per account",
  );
  assert.match(
    pendingIdx.indexdef,
    /where\s*\(status\s*=\s*'pending'::text\)/i,
    "pending drain index must filter status = pending",
  );

  // -------------------------------------------------------------------------
  // RLS + seer_app grants/policies on every account-scoped table
  // -------------------------------------------------------------------------
  const rls = await db.pool.query<{ relname: string; relrowsecurity: boolean }>(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer'
        and c.relkind = 'r'
        and c.relname = any($1::text[])`,
    [CORE_TABLES],
  );
  assert.equal(rls.rowCount, CORE_TABLES.length, "all core/V3 tables must be present");
  for (const t of CORE_TABLES) {
    assert.equal(rls.rows.find((r) => r.relname === t)?.relrowsecurity, true, `RLS on seer.${t}`);
  }

  const kv = await db.pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'seer_kv'`,
  );
  assert.equal(kv.rowCount, 1, "public.seer_kv must be migration-created");
  const kvRls = await db.pool.query<{ relrowsecurity: boolean }>(
    `select c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'seer_kv'`,
  );
  assert.equal(kvRls.rows[0]?.relrowsecurity, true, "RLS on public.seer_kv");

  const role = await db.pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = 'seer_app') as exists",
  );
  assert.equal(role.rows[0].exists, true, "seer_app role must exist for least-privilege grants");

  for (const table of CORE_TABLES) {
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
  const kvGrants = await db.pool.query<{ privilege_type: string }>(
    `select privilege_type
       from information_schema.role_table_grants
      where grantee = 'seer_app'
        and table_schema = 'public'
        and table_name = 'seer_kv'`,
  );
  for (const need of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.ok(
      new Set(kvGrants.rows.map((r) => r.privilege_type)).has(need),
      `seer_app must have ${need} on public.seer_kv`,
    );
  }

  const seqGrants = await db.pool.query<{ object_name: string; privilege_type: string }>(
    `select object_name, privilege_type
       from information_schema.usage_privileges
      where grantee = 'seer_app'
        and object_schema = 'seer'
        and object_type = 'SEQUENCE'`,
  );
  const sequences = await db.pool.query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer' and c.relkind = 'S'`,
  );
  if (sequences.rowCount > 0) {
    const granted = new Set(seqGrants.rows.map((r) => `${r.object_name}:${r.privilege_type}`));
    for (const seq of sequences.rows) {
      assert.ok(
        granted.has(`${seq.relname}:USAGE`),
        `seer_app must have USAGE on seer.${seq.relname}`,
      );
    }
  }

  const policies = await db.pool.query<{ tablename: string; policyname: string; roles: string[] }>(
    `select tablename, policyname, roles
       from pg_policies
      where schemaname = 'seer'
        and tablename = any($1::text[])
        and 'seer_app' = any(roles)`,
    [CORE_TABLES],
  );
  assert.equal(
    policies.rowCount,
    CORE_TABLES.length,
    "each core/V3 table needs an explicit seer_app RLS policy",
  );
  const kvPolicy = await db.pool.query<{ policyname: string; roles: string[] }>(
    `select policyname, roles
       from pg_policies
      where schemaname = 'public'
        and tablename = 'seer_kv'
        and 'seer_app' = any(roles)`,
  );
  assert.equal(kvPolicy.rowCount, 1, "public.seer_kv needs an explicit seer_app RLS policy");
  for (const role of ["anon", "authenticated"]) {
    const exists = await db.pool.query<{ exists: boolean }>(
      "select exists(select 1 from pg_roles where rolname = $1) as exists",
      [role],
    );
    if (exists.rows[0].exists) {
      const denied = await db.pool.query<{ allowed: boolean }>(
        "select has_table_privilege($1, 'public.seer_kv', 'select') as allowed",
        [role],
      );
      assert.equal(denied.rows[0].allowed, false, `${role} must not read public.seer_kv`);
      for (const table of CORE_TABLES) {
        const tableDenied = await db.pool.query<{ allowed: boolean }>(
          "select has_table_privilege($1, $2, 'select') as allowed",
          [role, `seer.${table}`],
        );
        assert.equal(
          tableDenied.rows[0].allowed,
          false,
          `${role} must not read seer.${table}`,
        );
      }
    }
  }

  // Exercise the actual application role, not only information_schema grants.
  await db.pool.query("set role seer_app");
  try {
    const appUser = await db.pool.query<{ id: string }>(
      "insert into seer.users (email) values ('seer-app@test.local') returning id",
    );
    await db.pool.query(
      `insert into seer.mail_accounts (user_id, provider, email)
       values ($1, 'google', 'seer-app@test.local')`,
      [appUser.rows[0].id],
    );
    await db.pool.query(
      `insert into public.seer_kv (key, value)
       values ('seer-app-test', '{"ok":true}'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    const appRead = await db.pool.query<{ ok: boolean }>(
      "select (value->>'ok')::boolean as ok from public.seer_kv where key = 'seer-app-test'",
    );
    assert.equal(appRead.rows[0].ok, true, "seer_app must read/write corpus and KV");
  } finally {
    await db.pool.query("reset role");
  }

  console.log("v3-schema: OK");
} finally {
  await db.stop();
}
