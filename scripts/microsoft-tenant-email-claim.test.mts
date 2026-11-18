/**
 * Microsoft sign-in must not treat the mutable Entra `email` claim as the
 * Seer user. These tests drive the real Auth.js callback
 * (`@auth/core` 0.41.3, the version next-auth 5.0.0-beta.32 ships) and the
 * app callbacks in src/auth.ts.
 *
 * They assert the safe outcome, so they fail while the current code accepts
 * the claim. A fix should:
 * - refuse a token whose `tid` is not the configured directory when the
 *   issuer is left on the multi-tenant common endpoint
 * - authorize the username (`preferred_username`) inside the pinned tenant,
 *   and persist that address, not the `email` claim
 * - leave an existing user's rows, credentials, matters, and Salesforce
 *   data untouched unless the tenant and username are that user's
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORG_TENANT = "11111111-1111-4111-8111-111111111111";
const ATTACKER_TENANT = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const COLLEAGUE = "colleague@rditrials.com";
const ATTACKER_USERNAME = "intruder@evil.onmicrosoft.com";
const CORPUS = "CONFIDENTIAL-CORPUS-MARKER";
const MATTER = "CONFIDENTIAL-MATTER-MARKER";
const PIPELINE = 424242;
const APP_ORIGIN = "http://127.0.0.1:3000";

const caseName = process.env.SEER_MS_CASE;

if (!caseName) {
  const script = fileURLToPath(import.meta.url);
  const tsconfig = fileURLToPath(new URL("./microsoft-claim.tsconfig.json", import.meta.url));
  let failed = 0;
  for (const name of ["unset", "pinned"]) {
    const result = spawnSync(
      "npx",
      ["tsx", "--tsconfig", tsconfig, script],
      {
        env: { ...process.env, SEER_MS_CASE: name },
        stdio: "inherit",
      },
    );
    if (result.status !== 0) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}

const { requestCookies } = await import("./next-headers-request-scope.mjs");

process.env.NODE_ENV = "test";
process.env.AUTH_URL = APP_ORIGIN;
process.env.AUTH_SECRET = "test-auth-secret-placeholder";
process.env.AUTH_TRUST_HOST = "true";
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = CLIENT_ID;
process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = "test-client-secret-placeholder";
delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
delete process.env.SEER_ALLOWED_EMAILS;
delete process.env.SEER_ALLOWED_EMAIL_DOMAINS;
delete process.env.ALLOWED_EMAIL;
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
if (caseName === "pinned") {
  process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = `https://login.microsoftonline.com/${ORG_TENANT}/v2.0`;
}

const dataDir = await mkdtemp(join(tmpdir(), "seer-ms-email-"));
process.env.SEER_DATA_DIR = dataDir;

const { generateKeyPair, SignJWT } = await import("jose");
process.setSourceMapsEnabled(false);
await import("next/dist/server/node-environment-baseline.js");
const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { HeadersAdapter } = await import(
  "next/dist/server/web/spec-extension/adapters/headers.js"
);
const { startTestDb } = await import("./v2-testdb.mts");
const { OWNER_EMAIL } = await import("../src/lib/auth/org.ts");
const { upsertUser, upsertAccountWithCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { createMatter } = await import("../src/lib/store/manual-matters.ts");
const { saveSalesforce } = await import("../src/lib/store/salesforce.ts");

const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const issued = {
  tid: ATTACKER_TENANT,
  email: COLLEAGUE,
  preferredUsername: ATTACKER_USERNAME,
  nonce: "",
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.pathname.endsWith(".well-known/openid-configuration")) {
    const issuerBase = url.href.replace(/\/\.well-known\/openid-configuration$/, "");
    const tenant = issuerBase.split("/")[3] ?? "common";
    // The common metadata document uses the {tenantid} placeholder. Auth.js
    // rewrites it from the configured issuer. A directory-specific document
    // already names that directory, which is what the library leaves in place.
    const issuer = tenant === "common"
      ? "https://login.microsoftonline.com/{tenantid}/v2.0"
      : issuerBase;
    return Response.json({
      issuer,
      authorization_endpoint: `${issuerBase}/oauth2/v2.0/authorize`,
      token_endpoint: `${issuerBase}/oauth2/v2.0/token`,
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
      jwks_uri: `${issuerBase}/discovery/v2.0/keys`,
      response_types_supported: ["code", "id_token"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url.pathname.endsWith("/oauth2/v2.0/token")) {
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? rawBody
        : rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : "";
    if (!body.includes("grant_type=authorization_code")) {
      return Response.json({ error: "unsupported_grant" }, { status: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      email: issued.email,
      preferred_username: issued.preferredUsername,
      name: "Foreign directory user",
      oid: "33333333-3333-4333-8333-333333333333",
      tid: issued.tid,
    };
    // Auth.js only asks for a nonce when the provider checks include one.
    // The common Entra setup in this app does not, and a nonce claim is then
    // rejected. Include it only when the authorize redirect actually sent one.
    if (issued.nonce) claims.nonce = issued.nonce;
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(`https://login.microsoftonline.com/${issued.tid}/v2.0`)
      .setAudience(CLIENT_ID)
      .setSubject("foreign-directory-subject")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    return Response.json({
      token_type: "Bearer",
      scope: "openid profile email",
      expires_in: 3600,
      access_token: "attacker-access-placeholder",
      refresh_token: "attacker-refresh-placeholder",
      id_token: idToken,
    });
  }
  if (url.hostname.endsWith("microsoftonline.com") || url.hostname.endsWith("microsoft.com") || url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com")) {
    return Response.json({ error: "not_available_in_test" }, { status: 401 });
  }
  return realFetch(input, init);
};

const db = await startTestDb();

const { handlers } = await import("../src/auth.ts");
const accountsRoute = await import("../src/app/api/v3/accounts/route.ts");
const mailboxRoute = await import("../src/app/api/v3/mailbox/route.ts");
const mattersRoute = await import("../src/app/api/matters/route.ts");
const salesforceRoute = await import("../src/app/api/salesforce/route.ts");

function absorbCookies(jar, response) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (value.length === 0 || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function authRequest(method, path, jar, body) {
  const headers = new Headers();
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  let payload;
  if (body) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    payload = new URLSearchParams(body).toString();
  }
  const request = new NextRequest(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: payload,
  });
  const response = await requestCookies.run(cookie, () =>
    method === "POST" ? handlers.POST(request) : handlers.GET(request),
  );
  absorbCookies(jar, response);
  return response;
}

async function appRequest(handler, jar, request) {
  const cookie = cookieHeader(jar);
  const headers = HeadersAdapter.seal(
    new Headers({
      cookie,
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
    }),
  );
  // The route handlers call auth(), which reads the session through Next's
  // request store. This is the same cookie header the browser would send.
  const workStore = { route: "/api", forceStatic: false, dynamicShouldError: false };
  const workUnit = { type: "request", phase: "render", headers };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(workUnit, () =>
      requestCookies.run(cookie, () => handler(request)),
    ),
  );
}

async function snapshot() {
  const users = await db.pool.query(
    "select email, extract(epoch from updated_at) as updated from seer.users order by email",
  );
  const accounts = await db.pool.query(
    "select id::text, user_id::text, provider, email from seer.mail_accounts order by provider, email",
  );
  const credentials = await db.pool.query(
    "select account_id::text, ciphertext::text, version from seer.oauth_credentials order by account_id",
  );
  return JSON.stringify({
    users: users.rows,
    accounts: accounts.rows,
    credentials: credentials.rows,
  });
}

async function seedVictim(email, provider) {
  const userId = await upsertUser(email);
  const account = await upsertAccountWithCredentials({
    userId,
    provider,
    email,
    displayName: "Existing colleague",
    accessToken: "victim-access-placeholder",
    refreshToken: "victim-refresh-placeholder",
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  });
  const conversation = await db.pool.query(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, message_count, folders)
     values ($1, $2, $3, now(), 1, '{inbox}')
     returning id`,
    [account.id, `thread-${provider}`, CORPUS],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, snippet, body_text, sent_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [
      account.id,
      conversation.rows[0].id,
      `message-${provider}`,
      "sender@example.com",
      CORPUS,
      CORPUS,
    ],
  );
  await createMatter(email, { title: MATTER });
  await saveSalesforce(email, {
    studies: [],
    opportunities: [{ code: "RFQ-SECRET", name: MATTER, amount: PIPELINE }],
    sites: [],
  });
  return account.id;
}

async function microsoftCallback(jar) {
  const csrf = await authRequest("GET", "/api/auth/csrf", jar);
  const csrfBody = await csrf.json();
  const start = await authRequest("POST", "/api/auth/signin/microsoft-entra-id", jar, {
    csrfToken: csrfBody.csrfToken,
    callbackUrl: "/",
  });
  const location = start.headers.get("location");
  if (!location) {
    throw new Error(`Microsoft sign-in did not redirect (${start.status})`);
  }
  const authorize = new URL(location);
  issued.nonce = authorize.searchParams.get("nonce") ?? "";
  const callback = await authRequest(
    "GET",
    `/api/auth/callback/microsoft-entra-id?${new URLSearchParams({
      code: "foreign-directory-code",
      state: authorize.searchParams.get("state") ?? "",
    })}`,
    jar,
  );
  const callbackText = await callback.text();
  return { status: callback.status, location: callback.headers.get("location"), body: callbackText.slice(0, 500) };
}

async function sessionEmail(jar) {
  const response = await authRequest("GET", "/api/auth/session", jar);
  const body = await response.json();
  return body?.user?.email ?? null;
}

async function readSurfaces(jar) {
  const accounts = await appRequest(
    accountsRoute.GET,
    jar,
    new NextRequest(`${APP_ORIGIN}/api/v3/accounts`),
  );
  const mailbox = await appRequest(
    mailboxRoute.GET,
    jar,
    new NextRequest(`${APP_ORIGIN}/api/v3/mailbox`),
  );
  const matters = await appRequest(
    mattersRoute.GET,
    jar,
    new NextRequest(`${APP_ORIGIN}/api/matters`),
  );
  const salesforce = await appRequest(
    salesforceRoute.GET,
    jar,
    new NextRequest(`${APP_ORIGIN}/api/salesforce`),
  );
  return {
    accounts: { status: accounts.status, body: await accounts.text() },
    mailbox: { status: mailbox.status, body: await mailbox.text() },
    matters: { status: matters.status, body: await matters.text() },
    salesforce: { status: salesforce.status, body: await salesforce.text() },
  };
}

function assertUntouched(before, after, label) {
  if (before !== after) {
    throw new Error(
      `${label}: the callback wrote a user, mailbox, or credential before refusing`,
    );
  }
}

function assertNoVictimData(surfaces, label) {
  const blob = JSON.stringify(surfaces);
  if (blob.includes(CORPUS) || blob.includes(MATTER) || blob.includes(String(PIPELINE)) || blob.includes("RFQ-SECRET")) {
    throw new Error(`${label}: signed-in session can read stored mail, matters, or Salesforce data\n${blob.slice(0, 800)}`);
  }
}

async function switchAccount(jar, accountId) {
  const response = await appRequest(
    accountsRoute.POST,
    jar,
    new NextRequest(`${APP_ORIGIN}/api/v3/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "switch", id: accountId }),
    }),
  );
  return { status: response.status, body: await response.text() };
}

const failures = [];
async function check(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
  }
}

try {
  if (caseName === "unset") {
    const googleId = await seedVictim(COLLEAGUE, "google");
    await seedVictim(COLLEAGUE, "microsoft");

    await check("foreign tenant email claim", async () => {
      const before = await snapshot();
      const jar = new Map();
      issued.tid = ATTACKER_TENANT;
      issued.email = COLLEAGUE;
      issued.preferredUsername = ATTACKER_USERNAME;
      const callback = await microsoftCallback(jar);
      const email = await sessionEmail(jar);
      const surfaces = await readSurfaces(jar);
      const switched = await switchAccount(jar, googleId);
      if (email !== null || switched.status === 200) {
        throw new Error(
          `tenant ${ATTACKER_TENANT} username ${ATTACKER_USERNAME} email claim ${COLLEAGUE} signed in as ${email}; switch ${switched.status}; callback ${callback.status} ${callback.location}; accounts ${surfaces.accounts.body.slice(0, 400)}`,
        );
      }
      assertNoVictimData(surfaces, "foreign tenant email claim");
      assertUntouched(before, await snapshot(), "foreign tenant email claim");
    });

    await check("owner email claim", async () => {
      const before = await snapshot();
      const jar = new Map();
      issued.email = OWNER_EMAIL;
      issued.preferredUsername = ATTACKER_USERNAME;
      issued.tid = ATTACKER_TENANT;
      await microsoftCallback(jar);
      const ownerSession = await sessionEmail(jar);
      if (ownerSession !== null) {
        throw new Error(`signed in as ${ownerSession} using email claim ${OWNER_EMAIL}`);
      }
      const ownerRows = await db.pool.query(
        "select id from seer.users where email = $1",
        [OWNER_EMAIL],
      );
      if (ownerRows.rowCount !== 0) {
        throw new Error("created the owner mailbox user from the email claim");
      }
      assertUntouched(before, await snapshot(), "owner email claim");
    });

    await check("foreign tenant org-looking username", async () => {
      const before = await snapshot();
      const jar = new Map();
      issued.email = COLLEAGUE;
      issued.preferredUsername = COLLEAGUE;
      issued.tid = ATTACKER_TENANT;
      await microsoftCallback(jar);
      const spoofSession = await sessionEmail(jar);
      if (spoofSession !== null) {
        throw new Error(
          `username ${COLLEAGUE} from tenant ${ATTACKER_TENANT} signed in as ${spoofSession}`,
        );
      }
      assertUntouched(before, await snapshot(), "foreign tenant org-looking username");
    });
  } else if (caseName === "pinned") {
    await check("same tenant username", async () => {
      const jar = new Map();
      issued.tid = ORG_TENANT;
      issued.email = COLLEAGUE;
      issued.preferredUsername = COLLEAGUE;
      await microsoftCallback(jar);
      const legitEmail = await sessionEmail(jar);
      if (legitEmail !== COLLEAGUE) {
        throw new Error(`same-tenant username ${COLLEAGUE} did not sign in (session ${legitEmail})`);
      }
    });

    await check("email claim is a different allowed mailbox", async () => {
      await seedVictim(OWNER_EMAIL, "google");
      const beforeOwner = await snapshot();
      const jar = new Map();
      issued.tid = ORG_TENANT;
      issued.email = OWNER_EMAIL;
      issued.preferredUsername = COLLEAGUE;
      const mismatch = await microsoftCallback(jar);
      const mismatchEmail = await sessionEmail(jar);
      const surfaces = await readSurfaces(jar);
      if (mismatchEmail !== COLLEAGUE) {
        throw new Error(
          `username ${COLLEAGUE} email claim ${OWNER_EMAIL} produced session ${mismatchEmail} (${mismatch.status} ${mismatch.location})`,
        );
      }
      assertNoVictimData(surfaces, "email claim differed from username");
      const ownerAccounts = await db.pool.query(
        "select provider from seer.mail_accounts a join seer.users u on u.id = a.user_id where u.email = $1",
        [OWNER_EMAIL],
      );
      const providers = ownerAccounts.rows.map((row) => row.provider).sort();
      if (providers.join(",") !== "google") {
        throw new Error(`attached a mailbox to the owner user (${providers.join(",")})`);
      }
      const ownerCreds = JSON.parse(beforeOwner).credentials;
      const credsNow = JSON.parse(await snapshot()).credentials.filter((row) =>
        ownerCreds.some((previous) => previous.account_id === row.account_id),
      );
      if (JSON.stringify(credsNow) !== JSON.stringify(ownerCreds)) {
        throw new Error("replaced credentials on the user who already owned that address");
      }
    });
  } else {
    throw new Error(`unknown case ${caseName}`);
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
  console.log(`${caseName}: microsoft sign-in stayed bound to the tenant and username`);
} finally {
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
}
