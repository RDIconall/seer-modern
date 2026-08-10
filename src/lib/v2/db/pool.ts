import { Pool, type PoolClient } from "pg";

/**
 * The single durable connection for Seer v2. Postgres is the system of record;
 * there is no Redis or file fallback here. Callers that need a value the store
 * cannot give must handle that explicitly rather than silently degrade.
 *
 * The connection string is resolved once. In production it must exist — a
 * missing durable backend is a startup error, never a quiet switch to an
 * ephemeral one.
 */

function connectionString(): string | null {
  return (
    process.env.SEER_V2_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

let pool: Pool | null = null;

export function db(): Pool {
  if (pool) return pool;
  const cs = connectionString();
  if (!cs) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Seer v2 requires POSTGRES_URL (or SEER_V2_DATABASE_URL) in production",
      );
    }
    throw new Error("Seer v2 database URL is not configured");
  }
  pool = new Pool({
    connectionString: cs,
    max: Number(process.env.SEER_V2_PG_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Supabase's pooled endpoint serves a cert outside the runtime CA bundle;
    // verification is disabled only when talking to it over TLS. A local test
    // Postgres uses no TLS and ignores this.
    ssl: /supabase|pooler|amazonaws/i.test(cs)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  return pool;
}

/**
 * Point the singleton at an already-constructed pool. Tests use this to bind
 * the module to a local embedded Postgres; production never calls it.
 */
export function setPoolForTesting(p: Pool | null): void {
  pool = p;
}
