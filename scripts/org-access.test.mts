/**
 * Seer is an RDI desk: any @rditrials.com account can sign in.
 * There is no per-person allowlist, and none is required — but a mailbox that
 * belongs on this desk from outside the org can be named by the deployment,
 * because gating on the domain alone locked the owner's own Gmail out of their
 * own mail client with nothing but "Access Denied" to go on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowedDomains,
  allowedEmails,
  describeAccessRefusal,
  DOMAINS_ENV,
  EMAILS_ENV,
  isAllowedOrgEmail,
  LEGACY_EMAIL_ENV,
  ORG_DOMAIN,
  OWNER_EMAIL,
} from "../src/lib/auth/org.ts";

assert.equal(ORG_DOMAIN, "rditrials.com");
assert.equal(isAllowedOrgEmail("claire@rditrials.com"), true);
assert.equal(isAllowedOrgEmail("Conall@RDITrials.com"), true);
assert.equal(isAllowedOrgEmail("conall+atlas@rditrials.com"), true);
assert.equal(isAllowedOrgEmail("you@gmail.com"), false);
assert.equal(isAllowedOrgEmail("ceo@rditrials.com.evil.example"), false);
assert.equal(isAllowedOrgEmail("rditrials.com"), false);
assert.equal(isAllowedOrgEmail(null), false);
assert.equal(isAllowedOrgEmail(""), false);

// Nothing configured: the org domain, plus the desk's own mailbox by name.
assert.deepEqual(allowedDomains(), [ORG_DOMAIN]);
assert.deepEqual(allowedEmails(), [OWNER_EMAIL]);
assert.equal(isAllowedOrgEmail(OWNER_EMAIL), true, "the owner is not shut out");
assert.equal(isAllowedOrgEmail(OWNER_EMAIL.toUpperCase()), true);
assert.equal(
  isAllowedOrgEmail(`x${OWNER_EMAIL}`),
  false,
  "the owner's address is matched whole, not as a suffix",
);
assert.equal(
  isAllowedOrgEmail(`someone.else@${OWNER_EMAIL.split("@")[1]}`),
  false,
  "the address is named, its provider is not a domain gate",
);

// A refusal names the address and the setting that would admit it.
const refusal = describeAccessRefusal("you@gmail.com");
assert.match(refusal, /you@gmail\.com/);
assert.match(refusal, new RegExp(EMAILS_ENV));
assert.match(describeAccessRefusal(null), /no usable email address/);

// The desk's own mailbox, named by the deployment.
process.env[EMAILS_ENV] = " You@Gmail.com , second@example.com ";
try {
  assert.equal(isAllowedOrgEmail("you@gmail.com"), true);
  assert.equal(isAllowedOrgEmail("YOU@gmail.com"), true);
  assert.equal(isAllowedOrgEmail("second@example.com"), true);
  assert.equal(isAllowedOrgEmail("stranger@gmail.com"), false, "named, not the domain");
  assert.deepEqual(allowedEmails(), [
    OWNER_EMAIL,
    "you@gmail.com",
    "second@example.com",
  ]);
} finally {
  delete process.env[EMAILS_ENV];
}
assert.equal(isAllowedOrgEmail("you@gmail.com"), false, "the setting is not sticky");

// A deployment still carrying the pre-org single-address gate is still naming
// its owner, and is not locked out of its own mail client by an upgrade.
process.env[LEGACY_EMAIL_ENV] = "Owner@gmail.com";
try {
  assert.equal(isAllowedOrgEmail("owner@gmail.com"), true);
  assert.deepEqual(allowedEmails(), [OWNER_EMAIL, "owner@gmail.com"]);
} finally {
  delete process.env[LEGACY_EMAIL_ENV];
}

// An alias domain of the same company.
process.env[DOMAINS_ENV] = "@rdi.example, rditrials.co";
try {
  assert.equal(isAllowedOrgEmail("claire@rdi.example"), true);
  assert.equal(isAllowedOrgEmail("claire@rditrials.co"), true);
  assert.equal(isAllowedOrgEmail("claire@rditrials.com"), true, "the org still passes");
  assert.equal(isAllowedOrgEmail("claire@rdi.example.evil.test"), false);
  assert.deepEqual(allowedDomains(), [ORG_DOMAIN, "rdi.example", "rditrials.co"]);
} finally {
  delete process.env[DOMAINS_ENV];
}

const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
assert.match(auth, /signIn\s*\(/);
assert.match(auth, /isAllowedOrgEmail/);
assert.match(
  auth,
  /console\.warn\("\[auth\] sign-in refused:"/,
  "a refused sign-in says which mailbox and why in the logs",
);

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
