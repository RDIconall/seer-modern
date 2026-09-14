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
 *
 * The bypass has two halves that must agree. Middleware is billed as a
 * function invocation, so a background path also has to be excluded from the
 * matcher — otherwise every fan-out worker and chained hop pays for a
 * middleware call that only ever calls `next()`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { config, isCronPath } from "../src/middleware.ts";

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

assert.equal(config.matcher.length, 1, "one matcher pattern to keep in sync");
const matcher = new RegExp(`^${config.matcher[0]}$`);

const background = [
  ...crons.map((cron) => cron.path),
  "/api/v2/sync?accountId=aaaa",
  "/api/v2/read?accountId=aaaa&hop=3",
  "/api/v2/accounts/aaaa/wake",
  "/api/v3/outbox/drain",
  "/api/webhooks/gmail",
  "/api/webhooks/outlook",
];
for (const path of background) {
  assert.equal(
    matcher.test(path),
    false,
    `"${path}" is background work that middleware waves through anyway — ` +
      `excluding it from the matcher is what stops it being billed as a ` +
      `second function invocation. Update the matcher in src/middleware.ts.`,
  );
}

for (const path of ["/", "/m", "/settings", "/api/auth/callback/google", "/api/mail"]) {
  assert.ok(
    matcher.test(path),
    `"${path}" must still reach the middleware to be funnelled`,
  );
}

console.log(
  `middleware-cron: ok (${crons.length} cron paths exempt, ` +
    `${background.length} background paths unbilled)`,
);
