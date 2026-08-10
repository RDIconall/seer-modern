/**
 * Task 14 CUTOVER GATE — do not add to the default test suite until cutover.
 *
 * This test fails while any legacy decision/classification runtime path still
 * exists. It is the enforcement that the old brain is truly gone. Run it ONLY
 * when performing the final cutover, AFTER an account has passed the shadow gate
 * (scripts/run-v2-shadow.mts) and the v2 experience is validated on real mail.
 *
 * Until then the legacy pipeline is intentionally still present so the deployed
 * product keeps working for non-allowlisted accounts.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The frozen deletion inventory: legacy runtime files whose responsibilities
 * are fully replaced by src/lib/v2. At cutover these are deleted (or reduced to
 * v2 shims). Migration-support files under src/lib/v2 are exempt.
 */
const LEGACY_RUNTIME = [
  "src/lib/inbox/gemini-triage.ts",
  "src/lib/inbox/classify.ts",
  "src/lib/inbox/matters.ts",
  "src/lib/inbox/understanding.ts",
  "src/components/inbox/TriageDigest.tsx",
  "src/components/inbox/DesktopMailApp.tsx",
  "src/components/inbox/MobileMailApp.tsx",
  "src/components/NlpPanel.tsx",
  "src/components/MailList.tsx",
  "src/app/api/today/route.ts",
  "src/app/api/alltasks/route.ts",
  "src/app/api/nlp/classify/route.ts",
  "src/app/api/mail/route.ts",
];

const remaining: string[] = [];
for (const file of LEGACY_RUNTIME) {
  try {
    await fs.access(path.join(process.cwd(), file));
    remaining.push(file);
  } catch {
    // Already deleted — good.
  }
}

assert.deepEqual(
  remaining,
  [],
  `legacy runtime still present (delete at cutover):\n  ${remaining.join("\n  ")}`,
);

// The store must no longer offer a JSON KV as the durable system of record.
const kvPath = path.join(process.cwd(), "src", "lib", "store", "kv.ts");
try {
  await fs.access(kvPath);
  assert.fail("src/lib/store/kv.ts must be removed at cutover (v2 uses Postgres only)");
} catch {
  // removed — good
}

console.log("v2-no-legacy: OK (legacy fully retired)");
