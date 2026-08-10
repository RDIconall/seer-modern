import { Pool, type PoolConfig } from "pg";
import { SUPABASE_ROOT_CA } from "./supabase-ca";

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

/**
 * Resolve the TLS settings for a connection string.
 *
 * `pg` ignores an explicitly passed `ssl` option whenever the connection string
 * carries an `sslmode` parameter — the string wins and the object is dropped.
 * Supabase's URLs ship with `sslmode=require`, which newer `pg` treats as
 * `verify-full` against the system CA bundle, and Supabase signs with its own
 * root. The result is a hard `SELF_SIGNED_CERT_IN_CHAIN` failure.
 *
 * So we strip the ssl parameters from the string and state the intent directly:
 * verification stays on, with Supabase's root pinned as an additional trust
 * anchor. Non-Supabase hosts keep the default system-CA verification.
 */
export function resolveSsl(cs: string): {
  connectionString: string;
  ssl: PoolConfig["ssl"];
} {
  let url: URL;
  try {
    url = new URL(cs);
  } catch {
    // Not a parseable URL (e.g. a key/value DSN); leave it untouched.
    return { connectionString: cs, ssl: undefined };
  }

  const declaredMode = url.searchParams.get("sslmode");
  for (const param of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) {
    url.searchParams.delete(param);
  }
  const stripped = url.toString();

  // An explicit opt-out is honoured; local Postgres serves no certificate.
  if (declaredMode === "disable") {
    return { connectionString: stripped, ssl: undefined };
  }

  if (/supabase|pooler/i.test(url.hostname)) {
    return {
      connectionString: stripped,
      ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
    };
  }

  // Nothing asked for TLS, so don't impose it: embedded test Postgres is plain.
  if (!declaredMode) return { connectionString: stripped, ssl: undefined };

  return { connectionString: stripped, ssl: { rejectUnauthorized: true } };
}

// The test override lives on globalThis, not a module-scoped variable: under
// tsx some modules load as CJS and others as ESM, which can create two
// instances of this file. A global key keeps a single shared override.
const OVERRIDE = Symbol.for("seer.v2.pool.override");

type GlobalWithOverride = typeof globalThis & { [OVERRIDE]?: Pool | null };

let pool: Pool | null = null;

export function db(): Pool {
  const override = (globalThis as GlobalWithOverride)[OVERRIDE];
  if (override) return override;
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
  const resolved = resolveSsl(cs);
  pool = new Pool({
    connectionString: resolved.connectionString,
    max: Number(process.env.SEER_V2_PG_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: resolved.ssl,
  });
  return pool;
}

/**
 * Point the singleton at an already-constructed pool. Tests use this to bind
 * the module to a local embedded Postgres; production never calls it.
 */
export function setPoolForTesting(p: Pool | null): void {
  (globalThis as GlobalWithOverride)[OVERRIDE] = p;
}
