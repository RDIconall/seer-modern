/**
 * Migrate sealed legacy account records into canonical v2 relational storage.
 *
 * Safe by default: without --apply this only reads and reports counts. It
 * never deletes the legacy records; Task 9 owns post-verification cleanup.
 *
 * Usage:
 *   npx tsx scripts/migrate-v3-accounts.mts
 *   npx tsx scripts/migrate-v3-accounts.mts --dry-run
 *   npx tsx scripts/migrate-v3-accounts.mts --apply
 */
import {
  normalizeEpochMs,
  upsertAccountWithCredentials,
  upsertUser,
} from "../src/lib/v2/db/accounts.ts";
import { listAccountsWithTokens } from "../src/lib/store/accounts.ts";
import type { StoredAccount } from "../src/lib/store/accounts.ts";

const apply = process.argv.includes("--apply");
const explicitlyDry = process.argv.includes("--dry-run");

function providerOf(provider: StoredAccount["provider"]): "google" | "microsoft" {
  return provider === "google" ? "google" : "microsoft";
}

async function main() {
  const previousFallback = process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
  // Migration is an explicit, server-only read of the sealed legacy store.
  // The normal request fallback remains disabled unless operators opt in.
  process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
  let accounts: StoredAccount[];
  try {
    accounts = await listAccountsWithTokens();
  } finally {
    if (previousFallback === undefined) {
      delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
    } else {
      process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = previousFallback;
    }
  }
  if (accounts.length === 0) {
    console.log("No legacy accounts found.");
    return;
  }

  const mode = apply && !explicitlyDry ? "apply" : "dry-run";
  console.log(`v3 account migration (${mode}): ${accounts.length} account(s)`);
  for (const legacy of accounts) {
    const provider = providerOf(legacy.provider);
    if (!apply || explicitlyDry) {
      console.log(`would migrate ${provider}:${legacy.email}`);
      continue;
    }

    const userId = await upsertUser(legacy.email);
    await upsertAccountWithCredentials({
      userId,
      provider,
      email: legacy.email,
      displayName: legacy.name,
      accessToken: legacy.accessToken,
      refreshToken: legacy.refreshToken,
      expiresAt: normalizeEpochMs(legacy.expiresAt),
    });
    console.log(`migrated ${provider}:${legacy.email}`);
  }
}

main().catch((cause) => {
  console.error(
    "v3 account migration failed:",
    cause instanceof Error ? cause.message : cause,
  );
  process.exitCode = 1;
});
