/**
 * Organization sign-in must not treat a Google email suffix as proof that the
 * account belongs to the company.
 *
 * Google's documented ID token puts the mailbox in `email` and, separately,
 * puts the Workspace domain in `hd`. `hd` is absent for an account that is
 * not in a hosted domain. These tests boot the Next.js server and complete
 * the real Auth.js callback (`/api/auth/callback/google` → `src/auth.ts`),
 * then call the account, switch, and corpus reader routes.
 *
 * `scripts/google-oidc-standin.cjs` answers Google's discovery and token
 * calls. `@auth/core` 0.41.3 and `oauth4webapi` 3.8.7 still parse the ID
 * token and run the sign-in and jwt callbacks. No production file is modified.
 *
 * Expected once the gate is fixed:
 * - A Google login admitted by the domain list is refused unless
 *   `email_verified` is set and `hd` equals that domain.
 * - A refused login does not write a user, mailbox, or credential row.
 * - A named allowlisted address (not a domain) can still sign in with Google
 *   when the email is verified, without `hd`.
 * - A verified Workspace login (`hd` matches) still signs in.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

const PORT = 35431;
const ORIGIN = `http://localhost:${PORT}`;
const VICTIM_EMAIL = "former.staff@rditrials.com";
const WORKSPACE_EMAIL = "claire.workspace@rditrials.com";
const BOARD_TEXT = "board minutes stay on the outlook mailbox";

// embedded-postgres ships versioned libraries without the SONAME symlinks
// initdb asks the loader for. Point the loader at a directory that has both.
try {
  const embeddedLib = path.join(
    process.cwd(),
    "node_modules/@embedded-postgres/linux-x64/native/lib",
  );
  const linked = path.join(tmpdir(), "seer-embedded-pg-lib");
  mkdirSync(linked, { recursive: true });
  for (const name of readdirSync(embeddedLib)) {
    try {
      symlinkSync(path.join(embeddedLib, name), path.join(linked, name));
    } catch {
      // already linked on a rerun
    }
    const soname = name.replace(/\.so\.(\d+)\..+$/, ".so.$1");
    if (soname !== name) {
      try {
        symlinkSync(path.join(embeddedLib, name), path.join(linked, soname));
      } catch {
        // already linked on a rerun
      }
    }
  }
  process.env.LD_LIBRARY_PATH = [linked, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
} catch {
  // Non-linux runners, or a machine that already has libpq on the loader path.
}

type GoogleClaims = {
  sub: string;
  email: string;
  email_verified?: boolean | string;
  hd?: string;
  name?: string;
};

function claimsCode(claims: GoogleClaims): string {
  return `claims.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
}

type CookieJar = Map<string, string>;

function absorb(jar: CookieJar, response: Response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, decodeURIComponent(value));
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

function hasSessionCookie(jar: CookieJar): boolean {
  return [...jar.keys()].some((name) => name.includes("session-token"));
}

async function request(
  jar: CookieJar,
  url: string,
  init: { method?: string; body?: string; contentType?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  headers.set("origin", ORIGIN);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  if (init.contentType) headers.set("content-type", init.contentType);
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
  });
  absorb(jar, response);
  return response;
}

async function googleCallback(jar: CookieJar, claims: GoogleClaims) {
  const csrf = await request(jar, `${ORIGIN}/api/auth/csrf`);
  const csrfBody = (await csrf.json()) as { csrfToken?: string };
  assert.ok(csrfBody.csrfToken, "Auth.js did not issue a CSRF token");
  const signIn = await request(jar, `${ORIGIN}/api/auth/signin/google`, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      csrfToken: csrfBody.csrfToken,
      callbackUrl: `${ORIGIN}/`,
    }).toString(),
  });
  assert.equal(signIn.status, 302, "Google sign-in did not start the OAuth redirect");
  const callback = await request(
    jar,
    `${ORIGIN}/api/auth/callback/google?code=${encodeURIComponent(claimsCode(claims))}`,
  );
  const location = callback.headers.get("location") ?? "";
  const text = callback.status === 302 ? "" : await callback.text();
  return { callback, location, text };
}

function refused(location: string, jar: CookieJar): boolean {
  return location.includes("error=") || !hasSessionCookie(jar);
}

async function googleAccountCount(db: TestDb, email: string): Promise<number> {
  const result = await db.pool.query(
    `select id from seer.mail_accounts where provider = 'google' and email = $1`,
    [email.toLowerCase()],
  );
  return result.rowCount ?? 0;
}

function startServer(databaseUrl: string): ChildProcess {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    AUTH_SECRET: "placeholder-auth-secret",
    AUTH_URL: ORIGIN,
    AUTH_GOOGLE_ID: "placeholder-google-client-id",
    AUTH_GOOGLE_SECRET: "placeholder-google-client-secret",
    AUTH_TRUST_HOST: "true",
    POSTGRES_URL: databaseUrl,
    SEER_V2_DATABASE_URL: "",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--require ${path.join(process.cwd(), "scripts/google-oidc-standin.cjs")}`,
  };
  delete env.AUTH_MICROSOFT_ENTRA_ID_ID;
  delete env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
  delete env.SEER_ALLOWED_EMAILS;
  delete env.SEER_ALLOWED_EMAIL_DOMAINS;
  delete env.ALLOWED_EMAIL;
  delete env.GMAIL_PUBSUB_TOPIC;
  return spawn(
    path.join(process.cwd(), "node_modules/.bin/next"),
    ["dev", "--turbopack", "-p", String(PORT)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitForServer(child: ChildProcess): Promise<void> {
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`next dev exited ${child.exitCode}\n${logs.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/api/auth/csrf`);
      if (response.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`next dev did not become ready\n${logs.slice(-4000)}`);
}

const db = await startTestDb();
const server = startServer(
  `postgres://postgres:postgres@127.0.0.1:${db.pool.options.port}/seer_test`,
);
try {
  await waitForServer(server);
  const { rawCredentialRow, upsertAccountWithCredentials, upsertUser } =
    await import("../src/lib/v2/db/accounts.ts");
  const { asAccountId } = await import("../src/lib/v2/db/types.ts");
  const { OWNER_EMAIL } = await import("../src/lib/auth/org.ts");

  const victimId = await upsertUser(VICTIM_EMAIL);
  const outlook = await upsertAccountWithCredentials({
    userId: victimId,
    provider: "microsoft",
    email: VICTIM_EMAIL,
    displayName: "Former staff Outlook",
    accessToken: "placeholder-outlook-access-token",
    refreshToken: "placeholder-outlook-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const conversation = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, message_count)
     values ($1, 'outlook-thread', 'Board pack', 1)
     returning id`,
    [outlook.id],
  );
  const conversationId = conversation.rows[0].id;
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, body_text, snippet, sent_at)
     values ($1, $2, 'outlook-message', 'director@rditrials.com', $3, $3, now())`,
    [outlook.id, conversationId, BOARD_TEXT],
  );
  const credentialBefore = await rawCredentialRow(outlook.id);

  // Control: a verified Workspace account whose hd matches the domain signs in,
  // and only receives the mailbox this login just linked.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-workspace-member",
      email: WORKSPACE_EMAIL,
      email_verified: "true",
      hd: "rditrials.com",
      name: "Claire Workspace",
    });
    assert.equal(
      result.callback.status,
      302,
      `workspace login failed: ${result.callback.status} ${result.location} ${result.text.slice(0, 500)}`,
    );
    assert.equal(
      refused(result.location, jar),
      false,
      `a verified Workspace account was refused: ${result.location}`,
    );
    assert.equal(await googleAccountCount(db, WORKSPACE_EMAIL), 1);
    const accounts = await request(jar, `${ORIGIN}/api/v3/accounts`);
    const accountsText = await accounts.text();
    assert.equal(accounts.status, 200, accountsText);
    const listed = JSON.parse(accountsText) as {
      accounts: { id: string; provider: string; email: string }[];
    };
    assert.deepEqual(
      listed.accounts.map((account) => account.email),
      [WORKSPACE_EMAIL],
    );
    assert.equal(
      listed.accounts.some((account) => account.id === outlook.id),
      false,
    );
  }

  // The attack: personal Google account, verified company address, no hd.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-personal-no-hd",
      email: VICTIM_EMAIL,
      email_verified: "true",
      name: "Former Staff",
    });
    assert.equal(
      refused(result.location, jar),
      true,
      `personal Google account without hd was signed in (${result.location})`,
    );
    assert.equal(
      await googleAccountCount(db, VICTIM_EMAIL),
      0,
      "a refused Google login must not link a mailbox onto the existing user",
    );
    assert.equal(
      await rawCredentialRow(outlook.id),
      credentialBefore,
      "a refused Google login must not rewrite the stored Outlook grant",
    );
    const accounts = await request(jar, `${ORIGIN}/api/v3/accounts`);
    assert.notEqual(accounts.status, 200);
    const switched = await request(jar, `${ORIGIN}/api/v3/accounts`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ action: "switch", id: outlook.id }),
    });
    assert.notEqual(switched.status, 200);
    const reader = await request(
      jar,
      `${ORIGIN}/api/v3/conversations/${conversationId}`,
    );
    const readerBody = await reader.text();
    assert.notEqual(reader.status, 200);
    assert.equal(readerBody.includes(BOARD_TEXT), false);
  }

  // Same address, verified, but hd is a different hosted domain.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-other-hd",
      email: VICTIM_EMAIL,
      email_verified: true,
      hd: "attacker.example",
      name: "Former Staff",
    });
    assert.equal(refused(result.location, jar), true, result.location);
    assert.equal(await googleAccountCount(db, VICTIM_EMAIL), 0);
    assert.equal(await rawCredentialRow(outlook.id), credentialBefore);
  }

  // Hosted domain matches, but Google says the address is not verified.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-unverified",
      email: "unverified.member@rditrials.com",
      email_verified: false,
      hd: "rditrials.com",
    });
    assert.equal(refused(result.location, jar), true, result.location);
    assert.equal(await googleAccountCount(db, "unverified.member@rditrials.com"), 0);
  }

  // Verified flag omitted entirely.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-no-flag",
      email: "noflag.member@rditrials.com",
      hd: "rditrials.com",
    });
    assert.equal(refused(result.location, jar), true, result.location);
    assert.equal(await googleAccountCount(db, "noflag.member@rditrials.com"), 0);
  }

  // Named allowlist, not the domain list: verified Gmail with no hd still enters.
  {
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-named-owner",
      email: OWNER_EMAIL,
      email_verified: "true",
      name: "Desk owner",
    });
    assert.equal(
      result.callback.status,
      302,
      `named mailbox login failed: ${result.location} ${result.text.slice(0, 500)}`,
    );
    assert.equal(refused(result.location, jar), false, result.location);
    assert.equal(await googleAccountCount(db, OWNER_EMAIL), 1);
    assert.equal(await googleAccountCount(db, VICTIM_EMAIL), 0);
  }

  // The same named address is refused when Google says it is unverified,
  // and the mailbox already linked by the verified login is left untouched.
  {
    const owner = await db.pool.query<{ id: string }>(
      `select id from seer.mail_accounts where provider = 'google' and email = $1`,
      [OWNER_EMAIL.toLowerCase()],
    );
    const ownerAccountId = asAccountId(owner.rows[0].id);
    const ownerCredentialBefore = await rawCredentialRow(ownerAccountId);
    const jar: CookieJar = new Map();
    const result = await googleCallback(jar, {
      sub: "google-sub-named-owner-unverified",
      email: OWNER_EMAIL,
      email_verified: false,
    });
    assert.equal(refused(result.location, jar), true, result.location);
    assert.equal(await rawCredentialRow(ownerAccountId), ownerCredentialBefore);
    const accounts = await request(jar, `${ORIGIN}/api/v3/accounts`);
    assert.notEqual(accounts.status, 200);
  }

  console.log("org-google-hosted-domain: OK");
} finally {
  server.kill("SIGTERM");
  await db.stop();
}
