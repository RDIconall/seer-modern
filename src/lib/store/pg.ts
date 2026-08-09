import { Pool } from "pg";

/**
 * POSTGRES (Supabase) — the durable, queryable home for Seer's memory.
 *
 * The whole app talks to storage through the kv facade; this module is the
 * Postgres backend behind it. It provisions its own schema at runtime
 * (the connection string is only available in the deployment, never on a
 * developer's machine), so there is no migration step to forget.
 *
 * Security (per Supabase's own guidance): every table lives in `public`,
 * which is reachable through the Data API, so RLS is ENABLED with NO
 * policies and privileges are revoked from `anon`/`authenticated`. Seer
 * connects as the privileged Postgres role (which bypasses RLS), so the
 * server keeps working while the anon/publishable keys can read nothing.
 */

function connectionString(): string | null {
  return (
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL ||
    null
  );
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
  pool = new Pool({
    connectionString: cs,
    // Supabase requires TLS; the pooled endpoint presents a cert chain the
    // serverless runtime doesn't always have — accept it explicitly.
    ssl: { rejectUnauthorized: false },
    // Serverless: keep the footprint small; the transaction pooler fans out.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  pool.on("error", (e) => {
    console.error("[seer] pg pool error:", e.message);
  });
  return pool;
}

let schemaReady: Promise<boolean> | null = null;

/** Create the schema once per instance. Idempotent; safe to await often. */
function ensureSchema(): Promise<boolean> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    if (!p) return false;
    try {
      await p.query(`
        create table if not exists seer_kv (
          key text primary key,
          value jsonb not null,
          expires_at timestamptz,
          updated_at timestamptz not null default now()
        );
        alter table seer_kv enable row level security;
        revoke all on seer_kv from anon, authenticated;
      `);
      return true;
    } catch (e) {
      console.error(
        "[seer] pg ensureSchema failed:",
        e instanceof Error ? e.message : e,
      );
      // Don't wedge the instance on a transient failure — let it retry.
      schemaReady = null;
      return false;
    }
  })();
  return schemaReady;
}

export async function pgGet<T>(key: string): Promise<T | null> {
  const p = getPool();
  if (!p) return null;
  if (!(await ensureSchema())) return null;
  const r = await p.query<{ value: T; expires_at: Date | null }>(
    "select value, expires_at from seer_kv where key = $1",
    [key],
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
  await p.query(
    `insert into seer_kv (key, value, expires_at, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = now()`,
    [key, JSON.stringify(value), expiresAt],
  );
}

export async function pgDelete(key: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  if (!(await ensureSchema())) return;
  await p.query("delete from seer_kv where key = $1", [key]);
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
    if (!(await ensureSchema())) return { ok: false, error: "schema" };
    const r = await p.query<{ n: string }>("select count(*)::text as n from seer_kv");
    return { ok: true, keys: Number(r.rows[0]?.n ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "error" };
  }
}
