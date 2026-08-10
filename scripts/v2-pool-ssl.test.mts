/**
 * The connection to Postgres carries the entire mail corpus, so its TLS
 * settings are a correctness AND a security concern.
 *
 * `pg` drops an explicitly passed `ssl` option whenever the connection string
 * contains `sslmode`. Supabase ships `sslmode=require` and signs with its own
 * root, so the naive configuration fails to connect at all — and the obvious
 * "fix" of rejectUnauthorized:false would silently accept any certificate.
 * These tests pin both halves: the parameter is stripped, and verification
 * stays on with Supabase's root as the trust anchor.
 */
import assert from "node:assert";
import { Client } from "pg";
import { resolveSsl } from "../src/lib/v2/db/pool.ts";
import { SUPABASE_ROOT_CA } from "../src/lib/v2/db/supabase-ca.ts";

const SUPABASE =
  "postgres://user:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require";

// 1. sslmode is removed, otherwise pg ignores everything we specify.
{
  const { connectionString } = resolveSsl(SUPABASE);
  assert.ok(
    !connectionString.includes("sslmode"),
    "sslmode must be stripped from the connection string",
  );
}

// 2. Verification stays ON, with Supabase's root pinned.
{
  const { ssl } = resolveSsl(SUPABASE);
  assert.ok(ssl && typeof ssl === "object", "Supabase must get explicit ssl");
  const opts = ssl as { ca?: string; rejectUnauthorized?: boolean };
  assert.equal(
    opts.rejectUnauthorized,
    true,
    "certificate verification must not be disabled",
  );
  assert.equal(opts.ca, SUPABASE_ROOT_CA, "Supabase root CA must be pinned");
}

// 3. The settings survive into the actual client, which is the thing that
//    silently failed before: pg re-parses the string per connection.
{
  const { connectionString, ssl } = resolveSsl(SUPABASE);
  const client = new Client({ connectionString, ssl });
  const resolved = client.connectionParameters.ssl as {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
  assert.ok(resolved, "client must retain ssl config");
  assert.equal(resolved.rejectUnauthorized, true);
  assert.equal(resolved.ca, SUPABASE_ROOT_CA);
}

// 4. Regression guard: with sslmode left in place, pg discards the ssl option.
//    This is the exact behaviour that broke production.
{
  const client = new Client({
    connectionString: SUPABASE,
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  });
  const resolved = client.connectionParameters.ssl as { ca?: string };
  assert.ok(
    !resolved || !resolved.ca,
    "expected pg to drop ssl when sslmode is present — if this fails, pg changed and resolveSsl can be simplified",
  );
}

// 5. A local test database without TLS parameters stays plaintext.
{
  const { ssl } = resolveSsl("postgres://postgres@127.0.0.1:5432/seer_test");
  assert.equal(ssl, undefined, "local Postgres must not be forced into TLS");
}

// 6. An explicit disable is honoured.
{
  const { ssl } = resolveSsl(
    "postgres://postgres@127.0.0.1:5432/seer_test?sslmode=disable",
  );
  assert.equal(ssl, undefined, "sslmode=disable must not enable TLS");
}

// 7. A non-Supabase TLS host keeps standard system-CA verification.
{
  const { ssl } = resolveSsl(
    "postgres://user:pw@db.example.com:5432/app?sslmode=require",
  );
  const opts = ssl as { ca?: string; rejectUnauthorized?: boolean };
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.ca, undefined, "do not pin Supabase's CA for other hosts");
}

console.log("v2 pool ssl: ok");
