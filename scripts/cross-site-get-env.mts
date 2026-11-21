/**
 * Runs before the app modules load. Static imports are hoisted, so this
 * file is imported first and is the only place process env is narrowed
 * for the cross-site GET tests.
 *
 * Values here are fixtures. None of them is a credential the app issued.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

// Next's request storage binds AsyncLocalStorage from globalThis at import.
// Node does not put it there until a server baseline does.
if (typeof globalThis.AsyncLocalStorage !== "function") {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}

process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "test-auth-secret-placeholder-not-a-credential";
process.env.AUTH_URL = "https://seer.example";
process.env.SEER_DATA_DIR = path.join(
  os.tmpdir(),
  `seer-cross-site-get-${process.pid}`,
);

for (const name of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "SEER_CREDENTIAL_KEY",
  "SEER_V3_LEGACY_ACCOUNT_FALLBACK",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_MICROSOFT_ENTRA_ID_ID",
  "AUTH_MICROSOFT_ENTRA_ID_SECRET",
  "AUTH_MICROSOFT_ENTRA_ID_ISSUER",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "CRON_SECRET",
]) {
  delete process.env[name];
}
