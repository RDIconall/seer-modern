/**
 * Task 4 gate (token service): concurrent callers trigger exactly one refresh,
 * the refresh token rotates, and a still-valid token is returned without a
 * refresh. Runs against embedded Postgres.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import {
  upsertUser,
  upsertAccount,
  saveCredentials,
  getCredentials,
} from "../src/lib/v2/db/accounts.ts";
import { freshAccessToken } from "../src/lib/v2/providers/token-service.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("tok@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "tok@example.com",
  });

  // Expired access token so a refresh is required.
  await saveCredentials(accountId, "google", {
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 1000,
  });

  let refreshCalls = 0;
  const refreshFn = async (refreshToken: string) => {
    refreshCalls++;
    assert.equal(refreshToken, "refresh-1");
    // Simulate provider latency so concurrent callers contend on the lock.
    await new Promise((r) => setTimeout(r, 50));
    return {
      accessToken: "new-access",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 3_600_000,
    };
  };

  // Five concurrent callers must yield exactly one refresh.
  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => freshAccessToken(accountId, "google", refreshFn)),
  );
  assert.deepEqual(new Set(tokens), new Set(["new-access"]));
  assert.equal(refreshCalls, 1, "advisory lock must serialize to one refresh");

  const rotated = await getCredentials(accountId);
  assert.equal(rotated?.refreshToken, "refresh-2", "refresh token must rotate");

  // A still-valid token needs no refresh.
  const again = await freshAccessToken(accountId, "google", refreshFn);
  assert.equal(again, "new-access");
  assert.equal(refreshCalls, 1, "valid token must not trigger another refresh");

  console.log("v2-token-service: OK");
} finally {
  await db.stop();
}
