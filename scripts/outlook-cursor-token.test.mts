/**
 * Caller-supplied Outlook cursors must not be fetched with the Graph access
 * token. These assertions fail while search, sync, and syncFolder treat the
 * cursor as a request URL. They pass once a cursor is fetched only when its
 * origin is https://graph.microsoft.com and its path stays under /v1.0/me
 * for the signed-in mailbox, and every other value is rejected before any
 * outbound request.
 *
 * Gmail search is covered as the boundary: its cursor is a page token on
 * gmail.googleapis.com, not a request URL.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.AUTH_SECRET ??= "placeholder-auth-secret";
process.env.SEER_CREDENTIAL_KEY ??= Buffer.alloc(32, 7).toString("base64");
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;

// Next's request storage uses globalThis.AsyncLocalStorage if it exists when
// the module is first loaded, and a stub that throws otherwise. Node keeps
// the class on node:async_hooks, so install it before importing next.
const { AsyncLocalStorage } = await import("node:async_hooks");
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage =
  AsyncLocalStorage;

const GRAPH_ACCESS_TOKEN = "placeholder-graph-access-token";
const SESSION_COOKIE = "authjs.session-token";
const MAILBOX = "victim@rditrials.com";

type Hit = { url: string; authorization: string | null };

const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { searchWithMetadata } = await import("../src/lib/v3/search/repository.ts");
const { asAccountId } = await import("../src/lib/v2/db/types.ts");
const { encode } = await import("@auth/core/jwt");

const failures: string[] = [];

function recordingFetch(hits: Hit[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    hits.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      JSON.stringify({ value: [], "@odata.count": 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function tokenAttached(hits: Hit[]): boolean {
  return hits.some((hit) => hit.authorization === `Bearer ${GRAPH_ACCESS_TOKEN}`);
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

async function expectNoRequest(
  name: string,
  hits: Hit[],
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch {
    // A refusal may throw. A request made before that throw is still a leak.
  }
  if (hits.length === 0) return;
  failures.push(
    `${name}: ${hits.length} request(s) before refusal; stored graph token attached=${tokenAttached(hits)}; first host=${hostOf(hits[0].url)}`,
  );
}

async function expectGraphMailboxRequest(
  name: string,
  hits: Hit[],
  cursor: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(
      `${name}: threw ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (hits.length !== 1 || !tokenAttached(hits)) {
    failures.push(
      `${name}: expected one Graph mailbox request with the stored token, saw ${hits.length} (token attached=${tokenAttached(hits)})`,
    );
    return;
  }
  let requested: URL;
  let expected: URL;
  try {
    requested = new URL(hits[0].url);
    expected = new URL(cursor);
  } catch {
    failures.push(`${name}: fetched a URL that does not parse`);
    return;
  }
  if (
    requested.origin !== "https://graph.microsoft.com" ||
    requested.origin !== expected.origin ||
    requested.pathname !== expected.pathname ||
    requested.search !== expected.search ||
    requested.username !== "" ||
    requested.password !== ""
  ) {
    failures.push(
      `${name}: fetched ${requested.origin}${requested.pathname} for cursor path ${expected.pathname}`,
    );
  }
}

function outlook(hits: Hit[]) {
  return new OutlookProvider({
    accessToken: GRAPH_ACCESS_TOKEN,
    accountEmail: MAILBOX,
    fetchImpl: recordingFetch(hits),
  });
}

const accountId = asAccountId("00000000-0000-4000-8000-000000000001");

const allowedSearch = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=placeholder";
const allowedSync =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=placeholder";
const allowedUpper =
  "https://GRAPH.MICROSOFT.COM/v1.0/me/messages?$skiptoken=placeholder";

const rejected = [
  "https://attacker.example/collect",
  "https://graph.microsoft.com.attacker.example/v1.0/me/messages",
  "https://graph.microsoft.com@attacker.example/v1.0/me/messages",
  "http://graph.microsoft.com/v1.0/me/messages",
  "https://graph.microsoft.com:8443/v1.0/me/messages",
  "https://graph.microsoft.com/v1.0/users/other/messages",
  "https://graph.microsoft.com/v1.0/meevil",
  "https://graph.microsoft.com/beta/me/messages",
  "https://graph.microsoft.com/v1.0/applications",
  "https://graph.microsoft.com/v1.0/me/messages/../../applications",
  "https://graph.microsoft.com/v1.0/me/messages/..%2f..%2fapplications",
  "https://graph.microsoft.com/v1.0/me%2fmessages",
  "https://graph.microsoft.com%2eattacker.example/v1.0/me/messages",
  "//attacker.example/collect",
  "https://attacker.example/v1.0/me/messages",
];

for (const cursor of rejected) {
  const searchHits: Hit[] = [];
  await expectNoRequest(`search ${cursor}`, searchHits, () =>
    searchWithMetadata(accountId, outlook(searchHits), "inbox", cursor),
  );
  const syncHits: Hit[] = [];
  await expectNoRequest(`sync ${cursor}`, syncHits, () =>
    outlook(syncHits).sync(cursor),
  );
  const folderHits: Hit[] = [];
  await expectNoRequest(`syncFolder ${cursor}`, folderHits, () =>
    outlook(folderHits).syncFolder("inbox", cursor),
  );
}

{
  const hits: Hit[] = [];
  await expectGraphMailboxRequest("search allowed next link", hits, allowedSearch, () =>
    searchWithMetadata(accountId, outlook(hits), "inbox", allowedSearch),
  );
}
{
  const hits: Hit[] = [];
  await expectGraphMailboxRequest("search uppercase host", hits, allowedUpper, () =>
    searchWithMetadata(accountId, outlook(hits), "inbox", allowedUpper),
  );
}
{
  const hits: Hit[] = [];
  await expectGraphMailboxRequest("syncFolder allowed next link", hits, allowedSync, () =>
    outlook(hits).syncFolder("inbox", allowedSync),
  );
}
{
  const hits: Hit[] = [];
  await expectGraphMailboxRequest("sync allowed next link", hits, allowedSync, () =>
    outlook(hits).sync(allowedSync),
  );
}
{
  const hits: Hit[] = [];
  const provider = outlook(hits);
  try {
    await provider.search("inbox", null);
  } catch (error) {
    failures.push(
      `search without cursor threw ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    hits.length !== 1 ||
    !tokenAttached(hits) ||
    new URL(hits[0]?.url ?? "http://invalid").origin !== "https://graph.microsoft.com" ||
    !new URL(hits[0]?.url ?? "http://invalid").pathname.startsWith("/v1.0/me/")
  ) {
    failures.push(
      `search without cursor did not stay on the signed-in Graph mailbox (requests=${hits.length}, token attached=${tokenAttached(hits)})`,
    );
  }
}

{
  const hits: Hit[] = [];
  const gmail = new GmailProvider({
    accessToken: GRAPH_ACCESS_TOKEN,
    accountEmail: MAILBOX,
    fetchImpl: recordingFetch(hits),
  });
  const cursor = "https://attacker.example/collect";
  try {
    await gmail.search("inbox", cursor);
  } catch (error) {
    failures.push(
      `gmail search threw ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requested = hits[0] ? new URL(hits[0].url) : null;
  if (
    hits.length !== 1 ||
    !tokenAttached(hits) ||
    requested?.host !== "gmail.googleapis.com" ||
    requested.pathname !== "/gmail/v1/users/me/threads" ||
    requested.searchParams.get("pageToken") !== cursor
  ) {
    failures.push(
      `gmail search must keep the cursor as a page token on gmail.googleapis.com (requests=${hits.length}, host=${requested?.host ?? "none"})`,
    );
  }
}

type Collector = {
  hits: Hit[];
  port: number;
  close: () => Promise<void>;
};

async function startCollector(): Promise<Collector> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    hits.push({
      url: `http://${host}${req.url ?? "/"}`,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
    });
    res.writeHead(200, { "content-type": "application/json" });
    // Count is present so sync does not follow up with a folder request.
    res.end(JSON.stringify({ value: [], "@odata.count": 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function callSearch(url: string, cookie: string): Promise<Response> {
  const { GET } = await import("../src/app/api/v3/search/route.ts");
  const { NextRequest } = await import("next/server");
  const { createRequestStoreForAPI } = await import(
    "next/dist/server/async-storage/request-store.js"
  );
  const { workAsyncStorage } = await import(
    "next/dist/server/app-render/work-async-storage.external.js"
  );
  const { workUnitAsyncStorage } = await import(
    "next/dist/server/app-render/work-unit-async-storage.external.js"
  );
  const request = new NextRequest(url, {
    headers: {
      cookie,
      host: "127.0.0.1",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "127.0.0.1",
    },
  });
  const requestStore = createRequestStoreForAPI(
    request,
    request.nextUrl,
    [],
    undefined,
    {
      previewModeId: "placeholder-preview-id",
      previewModeEncryptionKey: "placeholder-preview-encryption-key",
      previewModeSigningKey: "placeholder-preview-signing-key",
    },
  );
  const workStore = { route: "/api/v3/search" };
  return workUnitAsyncStorage.run(requestStore, () =>
    workAsyncStorage.run(workStore, () => GET(request)),
  );
}

const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccountWithCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);

const db = await startTestDb();
const collector = await startCollector();
try {
  const userId = await upsertUser(MAILBOX);
  const account = await upsertAccountWithCredentials({
    userId,
    provider: "microsoft",
    email: MAILBOX,
    accessToken: GRAPH_ACCESS_TOKEN,
    refreshToken: "placeholder-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const session = await encode({
    token: {
      email: MAILBOX,
      sub: MAILBOX,
      activeAccountId: account.id,
      provider: "microsoft-entra-id",
    },
    secret: process.env.AUTH_SECRET,
    salt: SESSION_COOKIE,
  });
  const cookie = `${SESSION_COOKIE}=${session}; seer_active_account=${account.id}`;

  const cursors = [
    `http://127.0.0.1:${collector.port}/collect`,
    `http://graph.microsoft.com@127.0.0.1:${collector.port}/collect`,
  ];
  for (const cursor of cursors) {
    collector.hits.length = 0;
    const endpoint = `http://127.0.0.1/api/v3/search?q=inbox&cursor=${encodeURIComponent(cursor)}`;
    let response: Response | null = null;
    let thrown = "";
    try {
      response = await callSearch(endpoint, cookie);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    const body = response ? await response.text() : "";
    if (tokenAttached(collector.hits) || collector.hits.length > 0) {
      failures.push(
        `GET ${cursor}: cursor was requested before refusal (requests=${collector.hits.length}, stored graph token attached=${tokenAttached(collector.hits)}, status=${response?.status ?? "thrown"})`,
      );
      continue;
    }
    if (thrown) {
      failures.push(
        `GET ${cursor}: handler built a request for a non-Graph cursor (${thrown.slice(0, 180)})`,
      );
      continue;
    }
    if (response?.status === 404 && body.includes("no active v2 account")) {
      throw new Error(`GET ${cursor} never authenticated the signed-in mailbox: ${body}`);
    }
    if ((response?.status ?? 500) >= 500) {
      throw new Error(`GET ${cursor} failed closed with ${response?.status}: ${body.slice(0, 300)}`);
    }
  }

  const live = new OutlookProvider({
    accessToken: GRAPH_ACCESS_TOKEN,
    accountEmail: MAILBOX,
  });
  for (const name of ["sync", "syncFolder"] as const) {
    collector.hits.length = 0;
    const cursor = `http://127.0.0.1:${collector.port}/${name}`;
    try {
      if (name === "sync") await live.sync(cursor);
      else await live.syncFolder("sent", cursor);
    } catch {
      // Refusal, or a response that is not a Graph page, may throw after the request.
    }
    if (collector.hits.length > 0) {
      failures.push(
        `${name} ${cursor}: cursor was requested before refusal (requests=${collector.hits.length}, stored graph token attached=${tokenAttached(collector.hits)})`,
      );
    }
  }
} finally {
  await collector.close();
  await db.stop();
}

assert.deepEqual(failures, [], failures.join("\n"));
console.log("outlook-cursor-token: OK");
