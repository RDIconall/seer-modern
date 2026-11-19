/**
 * Loaded before any application module so storage and auth read this
 * process, not a developer machine. Values here are placeholders.
 */
import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next's request storage uses globalThis.AsyncLocalStorage. Node does not
// put that class on the global object until the server runtime does.
const globals = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};
globals.AsyncLocalStorage ??= AsyncLocalStorage;

const nativeLib = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@embedded-postgres/linux-x64/native/lib",
);
// The published binaries need SONAME links (libpq.so.5) next to the
// versioned files (libpq.so.5.18). Creating them here keeps the test
// runnable without changing the package.
for (const file of readdirSync(nativeLib)) {
  const versioned = file.match(/^(.*\.so(?:\.\d+)*)\.(\d+)$/);
  if (!versioned) continue;
  const soname = versioned[1];
  if (soname === file) continue;
  const dest = path.join(nativeLib, soname);
  try {
    symlinkSync(file, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
process.env.LD_LIBRARY_PATH = [nativeLib, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

export const DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-profile-fallback-"));

process.env.SEER_DATA_DIR = DATA_DIR;
process.env.AUTH_SECRET = "placeholder-auth-secret-for-profile-tests";
process.env.AUTH_URL = "http://localhost:3000";
process.env.SEER_GEMINI_MODEL = "gemini-2.0-flash";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "placeholder-not-a-real-key";

for (const name of [
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SEER_USER_PROFILE",
  "SEER_USER_PROFILE_EMAIL",
  "SEER_USER_PROFILE_UPDATED_AT",
  "SEER_ALLOWED_EMAILS",
  "SEER_LEGACY_CRON",
  "SEER_V3_LEGACY_ACCOUNT_FALLBACK",
  "CRON_SECRET",
]) {
  delete process.env[name];
}
