import assert from "node:assert/strict";
import {
  resolveDatabaseUrl,
  validateProductionDatabaseUrl,
} from "../src/lib/v2/db/pool.ts";
import { shouldProvisionKvSchema } from "../src/lib/store/pg.ts";

const production = {
  NODE_ENV: "production",
  SEER_V2_DATABASE_URL:
    "postgres://seer_app:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  POSTGRES_URL: "postgres://postgres:secret@db.example.com/postgres",
};

assert.equal(
  resolveDatabaseUrl(production),
  production.SEER_V2_DATABASE_URL,
  "production must use the dedicated application URL",
);
assert.equal(
  validateProductionDatabaseUrl(production.SEER_V2_DATABASE_URL),
  production.SEER_V2_DATABASE_URL,
);
assert.equal(
  validateProductionDatabaseUrl(
    "postgres://seer_app.project:secret@pooler.supabase.com:6543/postgres",
  ),
  "postgres://seer_app.project:secret@pooler.supabase.com:6543/postgres",
  "Supabase pooler usernames may include the project suffix",
);
assert.throws(
  () =>
    resolveDatabaseUrl({
      NODE_ENV: "production",
      POSTGRES_URL: production.POSTGRES_URL,
    }),
  /SEER_V2_DATABASE_URL/,
);
assert.throws(
  () =>
    resolveDatabaseUrl({
      NODE_ENV: "production",
      SEER_V2_DATABASE_URL: production.POSTGRES_URL,
    }),
  /seer_app/,
);
assert.throws(
  () =>
    resolveDatabaseUrl({
      NODE_ENV: "production",
      SEER_V2_DATABASE_URL: "not-a-database-url",
    }),
  /URL|database/i,
);
assert.equal(
  resolveDatabaseUrl({
    NODE_ENV: "development",
    POSTGRES_URL: "postgres://postgres@localhost/seer",
  }),
  "postgres://postgres@localhost/seer",
  "development fallbacks remain available",
);

assert.equal(
  shouldProvisionKvSchema({ NODE_ENV: "production" }),
  false,
  "production restricted roles may probe but never provision KV",
);
assert.equal(
  shouldProvisionKvSchema({
    NODE_ENV: "production",
    SEER_KV_SETUP: "1",
  }),
  true,
  "explicit production setup is the only production provisioning escape hatch",
);
assert.equal(
  shouldProvisionKvSchema({ NODE_ENV: "test" }),
  true,
  "test databases may provision their local schema",
);

console.log("v3-production-security: OK");
