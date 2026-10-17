/**
 * BlueBubbles server passwords are sealed with the same envelope as OAuth
 * tokens. Legacy plaintext still loads; every write re-seals.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "seer-bb-"));
process.env.SEER_DATA_DIR = dataDir;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { kvGet, kvSet } = await import("../src/lib/store/kv.ts");
const {
  blueBubblesPasswordIsSealed,
  loadBlueBubbles,
  saveBlueBubbles,
} = await import("../src/lib/imessage/bluebubbles.ts");

const email = "bb-test@rditrials.com";

await kvSet(`bluebubbles:${email}`, {
  url: "http://mac.local:1234",
  password: "legacy-plain",
  savedAt: "2020-01-01T00:00:00.000Z",
});

const legacy = await loadBlueBubbles(email);
assert.equal(legacy?.password, "legacy-plain");

await saveBlueBubbles(email, { url: "http://mac.local:1234", password: "new-secret" });
const stored = await kvGet<{ password: unknown }>(`bluebubbles:${email}`);
assert.equal(blueBubblesPasswordIsSealed(stored?.password), true);
assert.ok(
  JSON.stringify(stored).includes("ciphertext"),
  "ciphertext lives in the KV document",
);
assert.equal(JSON.stringify(stored).includes("new-secret"), false);

const loaded = await loadBlueBubbles(email);
assert.equal(loaded?.password, "new-secret");
assert.equal(loaded?.url, "http://mac.local:1234");

await fs.rm(dataDir, { recursive: true, force: true });
console.log("v2-bluebubbles: OK");
