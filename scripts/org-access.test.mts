/**
 * Seer is an RDI desk: any @rditrials.com account can sign in.
 * There is no per-person allowlist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAllowedOrgEmail, ORG_DOMAIN } from "../src/lib/auth/org.ts";

assert.equal(ORG_DOMAIN, "rditrials.com");
assert.equal(isAllowedOrgEmail("claire@rditrials.com"), true);
assert.equal(isAllowedOrgEmail("Conall@RDITrials.com"), true);
assert.equal(isAllowedOrgEmail("conall+atlas@rditrials.com"), true);
assert.equal(isAllowedOrgEmail("you@gmail.com"), false);
assert.equal(isAllowedOrgEmail("ceo@rditrials.com.evil.example"), false);
assert.equal(isAllowedOrgEmail("rditrials.com"), false);
assert.equal(isAllowedOrgEmail(null), false);
assert.equal(isAllowedOrgEmail(""), false);

const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
assert.match(auth, /signIn\s*\(/);
assert.match(auth, /isAllowedOrgEmail/);

const session = readFileSync(
  new URL("../src/lib/mail/session.ts", import.meta.url),
  "utf8",
);
assert.match(session, /isAllowedOrgEmail/);
assert.doesNotMatch(session, /ALLOWED_EMAIL/);

const v2 = readFileSync(
  new URL("../src/lib/v2/session.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(v2, /SEER_V2_ACCOUNT_ALLOWLIST/);

const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
assert.doesNotMatch(env, /ALLOWED_EMAIL=/);
assert.doesNotMatch(env, /SEER_V2_ACCOUNT_ALLOWLIST=/);

console.log("org-access: OK");
