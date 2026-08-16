/**
 * Gate: every scheduled cron path must bypass the canonical-host redirect.
 *
 * Vercel invokes crons on the deployment's own URL, never the canonical host.
 * If the funnel redirects one, the Authorization header is dropped on the
 * redirect and the job quietly does nothing — while still logging a 200. That
 * exact gap silently disabled the v2 sync and read crons: the mailbox went
 * stale for hours and every dashboard looked green.
 *
 * This reads vercel.json so a newly scheduled cron cannot ship without an
 * exemption.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCronPath } from "../src/middleware.ts";

const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  crons?: { path: string; schedule: string }[];
};

const crons = vercelConfig.crons ?? [];
assert.ok(crons.length > 0, "expected scheduled crons in vercel.json");

for (const cron of crons) {
  assert.ok(
    isCronPath(cron.path),
    `scheduled cron "${cron.path}" is not exempt from the canonical-host ` +
      `redirect — it would be 308'd, lose its Authorization header, and ` +
      `silently never run. Add it to CRON_PATH_PREFIXES in src/middleware.ts.`,
  );
}

// The exemption must stay narrow: ordinary pages and the auth routes still
// need the funnel, because OAuth depends on cookies landing on one host.
for (const path of ["/", "/m", "/api/auth/callback/google", "/api/mail"]) {
  assert.equal(
    isCronPath(path),
    false,
    `"${path}" must still be funnelled to the canonical host`,
  );
}

console.log(`middleware-cron: ok (${crons.length} cron paths exempt)`);
