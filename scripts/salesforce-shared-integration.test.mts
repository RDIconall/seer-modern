/**
 * Spec for the shared Salesforce integration credential.
 *
 * A signed-in mailbox with no personal Salesforce connection must not be
 * able to read the deployment integration user's pipeline. These assertions
 * fail while that fallback is still wired into the settings sync and the
 * legacy cron, and they pass once those paths refuse it.
 *
 * The Salesforce HTTP stand-in follows src/lib/crm/salesforce-api.ts:
 * POST {loginUrl}/services/oauth2/token, then GET
 * {instance}/services/data/v61.0/query, /sobjects, and
 * /sobjects/{name}/describe. No request leaves this process.
 */
import "next/dist/server/node-environment-baseline.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";

const ATTACKER = "colleague@rditrials.com";
const CRON_UNCONNECTED = "unconnected-owner@rditrials.com";
const CRON_CONNECTED = "connected-owner@rditrials.com";
const INTEGRATION_LOGIN = "https://integration.example.test";
const USER_LOGIN = "https://login.salesforce.com";
const INSTANCE = "https://org.example.test";
const CLIENT_ID = "env-client-id-placeholder";
const CLIENT_SECRET = "env-client-secret-placeholder";
const REFRESH = "env-refresh-token-placeholder";
const USER_REFRESH = "user-refresh-token-placeholder";
const USERNAME = "integration-user@example.test";
const OPPORTUNITY = "Acme Expansion";
const STUDY = "RCD_2818";
const SITE = "Metro Clinic";
const AMOUNT = 250000;

const SF_ENV = [
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SALESFORCE_LOGIN_URL",
  "SALESFORCE_USERNAME",
  "SALESFORCE_PRIVATE_KEY",
  "SALESFORCE_REFRESH_TOKEN",
  "SF_CLIENT_ID",
  "SF_CLIENT_SECRET",
  "SF_LOGIN_URL",
  "SF_USERNAME",
  "SF_PRIVATE_KEY",
  "SF_REFRESH_TOKEN",
] as const;

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-sf-shared-"));
const authSecret = randomBytes(32).toString("hex");
const cronSecret = randomBytes(32).toString("hex");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

process.env.NODE_ENV = "test";
process.env.SEER_DATA_DIR = dataDir;
process.env.AUTH_SECRET = authSecret;
process.env.AUTH_URL = "http://localhost:3000";
process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
clearSalesforceEnv();

const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const { BRIEF_ENGINE, saveBrief } = await import("../src/lib/inbox/matters.ts");
const { kvDelete, kvSet } = await import("../src/lib/store/kv.ts");
const { loadSalesforce } = await import("../src/lib/store/salesforce.ts");
const {
  clearConnection,
  saveApp,
  saveConnection,
} = await import("../src/lib/store/salesforce-auth.ts");
const { GET, POST } = await import("../src/app/api/salesforce/route.ts");
const cron = await import("../src/app/api/cron/sync/route.ts");

type Call = { url: string; method: string; body: string };
const calls: Call[] = [];
const persisted: string[] = [];
const originalWrite = fs.writeFile.bind(fs);
fs.writeFile = async (file, data, options) => {
  persisted.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  return originalWrite(file, data, options);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (
    init?.method ??
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body == null
        ? ""
        : Buffer.from(init.body as Uint8Array).toString("utf8");
  calls.push({ url, method, body });

  if (url.startsWith("https://gmail.googleapis.com/")) {
    if (url.includes("/users/me/labels/INBOX")) {
      return json({ messagesTotal: 0, threadsTotal: 0 });
    }
    if (url.includes("/users/me/labels")) return json({ labels: [] });
    if (url.includes("/users/me/messages")) return json({ messages: [] });
    return json({});
  }

  if (url.includes("/services/oauth2/token") && method === "POST") {
    return json({
      access_token: "sf-access-placeholder",
      instance_url: INSTANCE,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Response("blocked", { status: 599 });
  }
  if (parsed.pathname === "/services/data/v61.0/query") {
    const q = parsed.searchParams.get("q") ?? "";
    if (/from\s+opportunity\b/i.test(q)) {
      return json({
        records: [
          {
            Name: OPPORTUNITY,
            StageName: "Proposal",
            Amount: AMOUNT,
            CloseDate: "2026-12-01",
            Account: { Name: "Acme" },
            Owner: { Name: "Pat Owner" },
          },
        ],
      });
    }
    if (/from\s+Study__c\b/i.test(q)) {
      return json({
        records: [
          {
            Name: STUDY,
            Title__c: "Cardio study",
            Status__c: "Active",
          },
        ],
      });
    }
    if (/from\s+Site__c\b/i.test(q)) {
      return json({
        records: [
          {
            Name: SITE,
            Investigator__c: "Dr Lee",
            City__c: "Austin",
          },
        ],
      });
    }
    return json({ records: [] });
  }
  if (parsed.pathname === "/services/data/v61.0/sobjects") {
    return json({
      sobjects: [
        { name: "Study__c", label: "Study", custom: true, queryable: true },
        { name: "Site__c", label: "Site", custom: true, queryable: true },
        {
          name: "Opportunity",
          label: "Opportunity",
          custom: false,
          queryable: true,
        },
      ],
    });
  }
  if (parsed.pathname === "/services/data/v61.0/sobjects/Study__c/describe") {
    return json({
      name: "Study__c",
      label: "Study",
      fields: [
        { name: "Name", label: "Name", type: "string" },
        { name: "Title__c", label: "Title", type: "string" },
        { name: "Status__c", label: "Status", type: "string" },
      ],
    });
  }
  if (parsed.pathname === "/services/data/v61.0/sobjects/Site__c/describe") {
    return json({
      name: "Site__c",
      label: "Site",
      fields: [
        { name: "Name", label: "Name", type: "string" },
        { name: "Investigator__c", label: "Investigator", type: "string" },
        { name: "City__c", label: "City", type: "string" },
      ],
    });
  }
  return new Response("blocked", { status: 599 });
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clearSalesforceEnv(): void {
  for (const key of SF_ENV) delete process.env[key];
}

function salesforceCalls(): Call[] {
  return calls.filter(
    (call) =>
      call.url.includes("/services/oauth2/token") ||
      call.url.includes("/services/data/"),
  );
}

function grant(call: Call): string | null {
  return new URLSearchParams(call.body).get("grant_type");
}

function leaked(text: string): boolean {
  return (
    text.includes(OPPORTUNITY) ||
    text.includes(STUDY) ||
    text.includes(SITE) ||
    text.includes(String(AMOUNT))
  );
}

const failures: string[] = [];
function expect(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

const sessionToken = await encode({
  token: {
    email: ATTACKER,
    name: "Colleague",
    provider: "google",
    sub: "colleague",
  },
  secret: authSecret,
  salt: "authjs.session-token",
});

async function asAttacker<T>(run: () => Promise<T>): Promise<T> {
  const req = new NextRequest("http://localhost:3000/api/salesforce", {
    headers: {
      cookie: `authjs.session-token=${sessionToken}`,
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });
  const requestStore = createRequestStoreForAPI(
    req,
    req.nextUrl,
    [],
    undefined,
    {
      previewModeId: "test-preview",
      previewModeEncryptionKey: "test-preview-encryption",
      previewModeSigningKey: "test-preview-signing",
    },
  );
  const workStore = {
    route: "/api/salesforce",
    page: "/api/salesforce",
    forceStatic: false,
    dynamicShouldError: false,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, run),
  );
}

async function sync(actionBody: Record<string, unknown> = { action: "sync" }) {
  return asAttacker(() =>
    POST(
      new Request("http://localhost:3000/api/salesforce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(actionBody),
      }),
    ),
  );
}

async function settings() {
  const response = await asAttacker(() => GET());
  return response.json() as Promise<Record<string, unknown>>;
}

const embeddedLib = path.join(
  process.cwd(),
  "node_modules/@embedded-postgres/linux-x64/native/lib",
);
try {
  const entries = await fs.readdir(embeddedLib);
  process.env.LD_LIBRARY_PATH = [embeddedLib, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
  for (const entry of entries) {
    const soname = entry.match(/^(.*\.so\.\d+)/)?.[1];
    if (!soname || soname === entry || entries.includes(soname)) continue;
    await fs.symlink(entry, path.join(embeddedLib, soname)).catch(() => {});
  }
} catch {
  // A machine Postgres, or an embedded build that already has its sonames.
}
const db = await startTestDb();
try {
  const userId = await accounts.upsertUser(ATTACKER);
  await accounts.upsertAccountWithCredentials({
    userId,
    provider: "google",
    email: ATTACKER,
    displayName: "Colleague",
    accessToken: "mailbox-access-placeholder",
    refreshToken: "mailbox-refresh-placeholder",
    expiresAt: Date.now() + 3_600_000,
  });
  await clearConnection(ATTACKER);

  const modes: Array<{ name: string; env: Record<string, string> }> = [
    {
      name: "jwt bearer",
      env: {
        SALESFORCE_CLIENT_ID: CLIENT_ID,
        SALESFORCE_LOGIN_URL: INTEGRATION_LOGIN,
        SALESFORCE_USERNAME: USERNAME,
        SALESFORCE_PRIVATE_KEY: privateKey,
      },
    },
    {
      name: "refresh token",
      env: {
        SALESFORCE_CLIENT_ID: CLIENT_ID,
        SALESFORCE_LOGIN_URL: INTEGRATION_LOGIN,
        SALESFORCE_REFRESH_TOKEN: REFRESH,
      },
    },
    {
      name: "client credentials",
      env: {
        SALESFORCE_CLIENT_ID: CLIENT_ID,
        SALESFORCE_LOGIN_URL: INTEGRATION_LOGIN,
        SALESFORCE_CLIENT_SECRET: CLIENT_SECRET,
      },
    },
    {
      name: "SF_ aliases",
      env: {
        SF_CLIENT_ID: CLIENT_ID,
        SF_LOGIN_URL: INTEGRATION_LOGIN,
        SF_CLIENT_SECRET: CLIENT_SECRET,
      },
    },
  ];

  for (const mode of modes) {
    clearSalesforceEnv();
    Object.assign(process.env, mode.env);
    await kvDelete(`salesforce:${ATTACKER}`);
    calls.length = 0;
    persisted.length = 0;
    const before = persisted.length;
    const response = await sync();
    const body = (await response.json()) as { error?: string; ok?: boolean };
    const touched = salesforceCalls();
    const stored = await loadSalesforce(ATTACKER);
    const written = persisted.slice(before).some(leaked);
    expect(
      response.status === 400 && /isn't connected/i.test(body.error ?? ""),
      `${mode.name}: sync without a personal connection returned ${response.status} ${body.error ?? body.ok}`,
    );
    expect(
      touched.length === 0,
      `${mode.name}: sync contacted Salesforce (${touched.map((call) => grant(call) ?? new URL(call.url).pathname).join(", ")})`,
    );
    expect(
      stored.opportunities.length === 0 &&
        stored.studies.length === 0 &&
        (stored.sites?.length ?? 0) === 0 &&
        !written,
      `${mode.name}: integration rows were stored on ${ATTACKER}`,
    );
    calls.length = 0;
    const view = await settings();
    const counts = view.counts as { opportunities?: number } | undefined;
    expect(
      view.pipelineValue == null &&
        (counts?.opportunities ?? 0) === 0 &&
        view.studyObject == null &&
        view.siteObject == null,
      `${mode.name}: settings exposed the integration pipeline or object names`,
    );
  }

  clearSalesforceEnv();
  process.env.SALESFORCE_CLIENT_ID = CLIENT_ID;
  process.env.SALESFORCE_LOGIN_URL = INTEGRATION_LOGIN;
  process.env.SALESFORCE_USERNAME = USERNAME;
  process.env.SALESFORCE_PRIVATE_KEY = privateKey;
  await saveApp(ATTACKER, {
    clientId: "user-consumer-key-placeholder",
    loginUrl: USER_LOGIN,
  });
  await saveConnection(ATTACKER, {
    refreshToken: USER_REFRESH,
    instanceUrl: INSTANCE,
    loginUrl: USER_LOGIN,
    username: ATTACKER,
    connectedAt: new Date().toISOString(),
  });
  calls.length = 0;
  const own = await sync();
  const ownBody = (await own.json()) as { ok?: boolean; error?: string };
  const ownCalls = salesforceCalls();
  const ownToken = ownCalls.find((call) => call.url.includes("/services/oauth2/token"));
  const ownStored = await loadSalesforce(ATTACKER);
  expect(own.status === 200 && ownBody.ok === true, `personal connection sync failed: ${own.status} ${ownBody.error ?? ""}`);
  expect(
    ownToken != null &&
      grant(ownToken) === "refresh_token" &&
      new URLSearchParams(ownToken.body).get("refresh_token") === USER_REFRESH &&
      !ownToken.body.includes("jwt-bearer"),
    "personal connection did not authenticate with that mailbox's own refresh token",
  );
  expect(
    ownStored.opportunities.some(
      (row) => row.name === OPPORTUNITY && row.amount === AMOUNT && row.owner === "Pat Owner",
    ) &&
      ownStored.studies.some((row) => row.code === STUDY) &&
      (ownStored.sites ?? []).some((row) => row.name === SITE),
    "personal connection did not keep the rows it was authorized to read",
  );

  await clearConnection(ATTACKER);
  clearSalesforceEnv();
  process.env.SALESFORCE_CLIENT_ID = CLIENT_ID;
  process.env.SALESFORCE_LOGIN_URL = INTEGRATION_LOGIN;
  process.env.SALESFORCE_USERNAME = USERNAME;
  process.env.SALESFORCE_PRIVATE_KEY = privateKey;
  process.env.SEER_LEGACY_CRON = "on";
  process.env.CRON_SECRET = cronSecret;

  await seedMailbox(CRON_UNCONNECTED, null);
  calls.length = 0;
  persisted.length = 0;
  const cronDenied = await cron.GET(
    new Request("http://localhost:3000/api/cron/sync", {
      headers: { authorization: `Bearer ${cronSecret}` },
    }),
  );
  const cronBody = (await cronDenied.json()) as {
    disabled?: string;
    report?: { email?: string; error?: string; crmSynced?: boolean }[];
  };
  const cronStored = await loadSalesforce(CRON_UNCONNECTED);
  const cronTouched = salesforceCalls();
  expect(
    cronBody.disabled == null,
    "legacy cron did not run, so the shared-credential path was not exercised",
  );
  expect(
    !cronBody.report?.some((row) => row.email === CRON_UNCONNECTED && row.error),
    `legacy cron failed before CRM for ${CRON_UNCONNECTED}: ${cronBody.report?.find((row) => row.email === CRON_UNCONNECTED)?.error ?? "no report row"}`,
  );
  expect(
    cronTouched.length === 0 &&
      cronStored.opportunities.length === 0 &&
      !persisted.some(leaked) &&
      !cronBody.report?.some((row) => row.email === CRON_UNCONNECTED && row.crmSynced),
    "legacy cron synced the integration user into a mailbox with no personal connection",
  );

  await saveApp(CRON_CONNECTED, {
    clientId: "user-consumer-key-placeholder",
    loginUrl: USER_LOGIN,
  });
  await saveConnection(CRON_CONNECTED, {
    refreshToken: USER_REFRESH,
    instanceUrl: INSTANCE,
    loginUrl: USER_LOGIN,
    username: CRON_CONNECTED,
    connectedAt: new Date().toISOString(),
  });
  await seedMailbox(CRON_CONNECTED, null);
  calls.length = 0;
  const cronOwn = await cron.GET(
    new Request("http://localhost:3000/api/cron/sync", {
      headers: { authorization: `Bearer ${cronSecret}` },
    }),
  );
  const cronOwnBody = (await cronOwn.json()) as {
    report?: { email?: string; error?: string; crmSynced?: boolean }[];
  };
  const cronOwnCalls = salesforceCalls();
  const cronOwnToken = cronOwnCalls.find((call) =>
    call.url.includes("/services/oauth2/token"),
  );
  const cronOwnStored = await loadSalesforce(CRON_CONNECTED);
  expect(
    !cronOwnBody.report?.some((row) => row.email === CRON_CONNECTED && row.error),
    `legacy cron failed for a connected mailbox: ${cronOwnBody.report?.find((row) => row.email === CRON_CONNECTED)?.error ?? "no report row"}`,
  );
  expect(
    cronOwnToken != null &&
      grant(cronOwnToken) === "refresh_token" &&
      new URLSearchParams(cronOwnToken.body).get("refresh_token") === USER_REFRESH,
    "legacy cron did not use the mailbox's own Salesforce refresh token",
  );
  expect(
    cronOwnStored.opportunities.some((row) => row.amount === AMOUNT),
    "legacy cron did not store the connected mailbox's own sync",
  );
  expect(
    !cronOwnCalls.some(
      (call) => grant(call) === "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ),
    "legacy cron used the integration JWT for a mailbox that has its own connection",
  );
} finally {
  await db.stop();
  globalThis.fetch = originalFetch;
  fs.writeFile = originalWrite;
  await rm(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("salesforce-shared-integration: OK");

async function seedMailbox(email: string, syncedAt: string | null): Promise<void> {
  const store = {
    accounts: [
      {
        id: `acct-${email}`,
        provider: "google",
        email,
        name: email,
        accessToken: "mailbox-access-placeholder",
        refreshToken: "mailbox-refresh-placeholder",
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  await kvSet("accounts", store);
  await saveBrief(email, {
    builtAt: new Date().toISOString(),
    engine: BRIEF_ENGINE,
    summary: "quiet",
    matters: [],
    headlines: [],
    headlineIds: [],
  });
  if (syncedAt) {
    await kvSet(`salesforce:${email}`, {
      studies: [],
      opportunities: [],
      sites: [],
      syncedAt,
    });
  }
}
