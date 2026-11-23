import { BlockList, isIP } from "node:net";
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

export function validateProductionDatabaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error(
      "Production requires SEER_V2_DATABASE_URL; operator must provision its password",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SEER_V2_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SEER_V2_DATABASE_URL must use the postgres:// scheme");
  }
  const username = decodeURIComponent(url.username);
  if (username !== "seer_app" && !username.startsWith("seer_app.")) {
    throw new Error(
      "SEER_V2_DATABASE_URL must connect as seer_app (or seer_app.<project> through the Supabase pooler)",
    );
  }
  const { ssl, host } = resolveSsl(raw);
  if (!ssl && !isLocalDatabaseHost(host)) {
    throw new Error("SEER_V2_DATABASE_URL would connect without TLS to a non-local host");
  }
  return raw;
}

export function resolveDatabaseUrl(
  env: Partial<Pick<
    NodeJS.ProcessEnv,
    | "NODE_ENV"
    | "SEER_V2_DATABASE_URL"
    | "POSTGRES_URL"
    | "POSTGRES_PRISMA_URL"
    | "DATABASE_URL"
  >> = process.env,
): string | null {
  if (env.NODE_ENV === "production") {
    return validateProductionDatabaseUrl(env.SEER_V2_DATABASE_URL);
  }
  return (
    env.SEER_V2_DATABASE_URL ||
    env.POSTGRES_URL ||
    env.POSTGRES_PRISMA_URL ||
    env.DATABASE_URL ||
    null
  );
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** True only for hosts that never leave this machine: loopback IPs, `localhost`, Unix sockets. */
export function isLocalDatabaseHost(host: string): boolean {
  if (host.startsWith("/")) return true;
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (bare.toLowerCase() === "localhost") return true;
  const family = isIP(bare);
  if (family === 4) return LOOPBACK.check(bare, "ipv4");
  if (family === 6) return LOOPBACK.check(bare, "ipv6");
  return false;
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
 *
 * Any host that is not on this machine gets verified TLS whether or not the
 * URL asks for it, and `sslmode=disable` is refused for such hosts. Only a
 * local Postgres (embedded test databases) may run in cleartext. The host is
 * classified the way `pg` picks it — `?host=` first, then the URL host, then
 * `PGHOST`, then `localhost` — and pinned into the string so the classified
 * host is the one dialled.
 */
export function resolveSsl(cs: string): {
  connectionString: string;
  ssl: PoolConfig["ssl"];
  host: string;
} {
  let url: URL;
  try {
    url = new URL(cs);
  } catch {
    // `pg` treats a string starting with "/" as a Unix socket directory.
    if (cs.startsWith("/")) {
      return { connectionString: cs, ssl: undefined, host: cs.split(" ")[0] };
    }
    throw new Error(
      "Postgres connection string must be a postgres:// URL so its TLS policy can be enforced",
    );
  }

  const declaredMode = url.searchParams.get("sslmode");
  for (const param of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) {
    url.searchParams.delete(param);
  }

  const urlHost = decodeURIComponent(url.hostname);
  const queryHost = url.searchParams.get("host");
  const host = queryHost || urlHost || process.env.PGHOST || "localhost";
  if (!queryHost && !urlHost) url.searchParams.set("host", host);
  const stripped = url.toString();
  const local = isLocalDatabaseHost(host);

  if (declaredMode === "disable") {
    if (local) return { connectionString: stripped, ssl: undefined, host };
    throw new Error(
      `Refusing a cleartext Postgres connection to non-local host ${host}: sslmode=disable is only allowed for loopback addresses`,
    );
  }

  if (/supabase|pooler/i.test(host)) {
    return {
      connectionString: stripped,
      ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
      host,
    };
  }

  // A local embedded test Postgres serves no certificate.
  if (!declaredMode && local) return { connectionString: stripped, ssl: undefined, host };

  return { connectionString: stripped, ssl: { rejectUnauthorized: true }, host };
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
  const cs = resolveDatabaseUrl();
  if (!cs) {
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
