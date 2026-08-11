import { Pool } from "pg";
import { resolveDatabaseUrl, resolveSsl } from "@/lib/v2/db/pool";

/**
 * POSTGRES (Supabase) — the durable, queryable home for Seer's memory.
 *
 * The whole app talks to storage through the kv facade; this module is the
 * Postgres backend behind it. Development/test instances may provision the
 * compatibility table; production only probes the migration-owned table unless
 * an operator explicitly enables the one-time setup escape hatch.
 *
 * Security (per Supabase's own guidance): every table lives in `public`,
 * which is reachable through the Data API, so RLS is ENABLED with NO
 * policies and privileges are revoked from `anon`/`authenticated`. Seer
 * connects as the privileged Postgres role (which bypasses RLS), so the
 * server keeps working while the anon/publishable keys can read nothing.
 */

function connectionString(): string | null {
  return resolveDatabaseUrl();
}

export function pgEnabled(): boolean {
  return Boolean(connectionString());
}

let pool: Pool | null | undefined;

function getPool(): Pool | null {
  if (pool !== undefined) return pool;
  const cs = connectionString();
  if (!cs) {
    pool = null;
    return pool;
  }
  // One TLS policy for the whole app: strip the ssl parameters that would
  // otherwise make node-pg discard our settings, and verify against Supabase's
  // pinned root. This connection carries the mail corpus and, until V3
  // replaces this store, the sealed OAuth tokens — turning verification off
  // would encrypt the link while accepting any certificate offered.
  const resolved = resolveSsl(cs);
  pool = new Pool({
    connectionString: resolved.connectionString,
    ssl: resolved.ssl,
    // Serverless: keep the footprint small; the transaction pooler fans out.
    max: 3,
    idleTimeoutMillis: 10_000,
    // A user request must never wait 8s on a cold pool.
    connectionTimeoutMillis: 3_000,
  });
  pool.on("error", (e) => {
    console.error("[seer] pg pool error:", e.message);
  });
  return pool;
}

let schemaReady: Promise<boolean> | null = null;
let lastSchemaError: string | null = null;

export function shouldProvisionKvSchema(
  env: Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "SEER_KV_SETUP">> = process.env,
): boolean {
  return env.NODE_ENV !== "production" || env.SEER_KV_SETUP === "1";
}

/**
 * Storage must never hang a user request. A cold pool plus first-use DDL
 * once pushed a reply past the function limit, which returned an empty
 * body and surfaced as "Unexpected end of JSON input" in compose. Every
 * Postgres call is bounded; on timeout the kv facade falls back to Redis.
 */
const PG_TIMEOUT_MS = 3_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`pg ${label} timed out after ${PG_TIMEOUT_MS}ms`)),
        PG_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Create the schema once per instance. Idempotent; safe to await often. */
function ensureSchema(): Promise<boolean> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    if (!p) return false;

    // Ask whether the table is usable before trying to build it. The app now
    // connects as a least-privilege role that deliberately cannot run DDL, so
    // "I cannot create this" and "this does not work" are different answers —
    // treating them the same would take the store down on every cold start.
    try {
      await withTimeout(p.query("select 1 from seer_kv limit 1"), "probe");
      lastSchemaError = null;
      return true;
    } catch {
      if (!shouldProvisionKvSchema()) {
        lastSchemaError =
          "public.seer_kv is missing or inaccessible; apply migrations before production startup";
        return false;
      }
      // Fall through and provision only in development/test or explicit setup.
    }

    // Statements run one at a time: some poolers reject multi-statement
    // simple queries, and a REVOKE on a role that doesn't exist must not
    // sink the CREATE TABLE.
    const stmts = [
      `create table if not exists seer_kv (
         key text primary key,
         value jsonb not null,
         expires_at timestamptz,
         updated_at timestamptz not null default now()
       )`,
      `alter table seer_kv enable row level security`,
    ];
    try {
      for (const stmt of stmts) await withTimeout(p.query(stmt), "ddl");
    } catch (e) {
      lastSchemaError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      console.error("[seer] pg ensureSchema failed:", lastSchemaError);
      schemaReady = null; // transient — let the next call retry
      return false;
    }
    // Best-effort hardening; never fail schema readiness if the roles or
    // grants differ on this Postgres.
    await p
      .query(`revoke all on seer_kv from anon, authenticated`)
      .catch(() => {});
    lastSchemaError = null;
    return true;
  })();
  return schemaReady;
}

export async function pgGet<T>(key: string): Promise<T | null> {
  const p = getPool();
  if (!p) return null;
  if (!(await ensureSchema())) return null;
  const r = await withTimeout(
    p.query<{ value: T; expires_at: Date | null }>(
      "select value, expires_at from seer_kv where key = $1",
      [key],
    ),
    "get",
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    // Lazily reap expired rows (Postgres has no native TTL).
    await p.query("delete from seer_kv where key = $1", [key]).catch(() => {});
    return null;
  }
  return row.value;
}

export async function pgSet<T>(
  key: string,
  value: T,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  const p = getPool();
  if (!p) return;
  if (!(await ensureSchema())) throw new Error("pg schema not ready");
  const expiresAt = opts?.ttlSeconds
    ? new Date(Date.now() + opts.ttlSeconds * 1000)
    : null;
  await withTimeout(
    p.query(
      `insert into seer_kv (key, value, expires_at, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update
         set value = excluded.value,
             expires_at = excluded.expires_at,
             updated_at = now()`,
      [key, JSON.stringify(value), expiresAt],
    ),
    "set",
  );
}

export async function pgDelete(key: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  if (!(await ensureSchema())) return;
  await withTimeout(
    p.query("delete from seer_kv where key = $1", [key]),
    "delete",
  );
}

/** Connectivity + row count, for /api/health. */
export async function pgHealth(): Promise<{
  ok: boolean;
  keys?: number;
  error?: string;
}> {
  const p = getPool();
  if (!p) return { ok: false, error: "no connection string" };
  try {
    if (!(await ensureSchema())) {
      return { ok: false, error: lastSchemaError ?? "schema not ready" };
    }
    const r = await p.query<{ n: string }>("select count(*)::text as n from seer_kv");
    return { ok: true, keys: Number(r.rows[0]?.n ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "error" };
  }
}
