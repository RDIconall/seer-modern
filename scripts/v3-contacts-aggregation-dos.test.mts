/**
 * Contact suggestions must not scan every stored address on each request.
 *
 * GET /api/v3/contacts is a session-cookie GET. These tests call that handler
 * with a real Auth.js session cookie and run suggestContacts against embedded
 * Postgres. They fail while a request still groups every From/To address in
 * the shared messages table, or while a cross-site call is allowed to reach
 * the database.
 *
 * A fix should:
 * - read at most MAX_MESSAGE_ROWS_EXAMINED rows from seer.messages per call
 *   (a bounded recent-correspondent index, not a post-aggregation LIMIT),
 * - refuse a search string longer than MAX_QUERY_CHARS before that read,
 * - reject cross-site calls the way account changes already do, and do it
 *   before any database query.
 *
 * cc_emails are not part of this aggregation and are not asserted here.
 * The legacy GET /api/contacts path builds a cached provider history and is
 * a different operation.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { encode } from "@auth/core/jwt";
import type { Pool } from "pg";

// Next 15.5.23's request store uses globalThis.AsyncLocalStorage
// (node_modules/next/dist/server/app-render/async-local-storage.js). This
// runtime only exposes it from node:async_hooks, so install it before Next loads.
const globals = globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage };
globals.AsyncLocalStorage ??= AsyncLocalStorage;
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { suggestContacts } from "../src/lib/v3/contacts/repository.ts";

/** Rows of seer.messages one suggestion may read, however large the mailbox is. */
const MAX_MESSAGE_ROWS_EXAMINED = 512;
/** Search text longer than this must be refused before the address aggregation. */
const MAX_QUERY_CHARS = 256;
const APP_ORIGIN = "https://mail.example.test";
const SESSION_COOKIE = "__Secure-authjs.session-token";
/** Obvious placeholder. Not a deployed credential. */
const TEST_AUTH_SECRET = "contacts-dos-test-secret";
const MAILBOX_MESSAGES = 800;

const previousEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_URL: process.env.AUTH_URL,
  NODE_ENV: process.env.NODE_ENV,
};

process.env.AUTH_SECRET = TEST_AUTH_SECRET;
process.env.AUTH_URL = APP_ORIGIN;

type QueryCall = { text: string; values: unknown[] | undefined };

function trackQueries(pool: Pool): { calls: QueryCall[]; restore: () => void } {
  const calls: QueryCall[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
      calls.push({ text: first, values: args[1] as unknown[] | undefined });
    } else if (first && typeof first === "object" && "text" in first) {
      const query = first as { text?: string; values?: unknown[] };
      calls.push({ text: String(query.text), values: query.values });
    }
    return (original as (...inner: unknown[]) => unknown)(...args);
  }) as Pool["query"];
  return {
    calls,
    restore: () => {
      pool.query = original;
    },
  };
}

type PlanNode = {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
};

function messageRowsExamined(node: PlanNode | undefined): number {
  if (!node) return 0;
  const loops = node["Actual Loops"] ?? 1;
  let rows = 0;
  if (node["Relation Name"] === "messages") {
    rows +=
      ((node["Actual Rows"] ?? 0) +
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0)) *
      loops;
  }
  for (const child of node.Plans ?? []) rows += messageRowsExamined(child);
  return rows;
}

async function rowsExaminedBy(pool: Pool, call: QueryCall): Promise<number> {
  const explained = await pool.query({
    text: `explain (analyze, format json) ${call.text}`,
    values: call.values,
  });
  const plan = explained.rows[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>;
  return messageRowsExamined(plan[0]?.Plan);
}

function suggestionQueries(calls: QueryCall[]): QueryCall[] {
  return calls.filter(
    (call) =>
      /from\s+seer\.messages/i.test(call.text) && !/^\s*explain\b/i.test(call.text),
  );
}

async function seedMailbox(
  pool: Pool,
  accountId: string,
  prefix: string,
  count: number,
) {
  await pool.query(
    `with conv as (
       insert into seer.conversations
         (account_id, provider_conversation_id, subject, last_message_at, folders)
       values ($1, $2, $2, now(), array['inbox']::text[])
       returning id
     )
     insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, snippet, is_unread, is_outgoing)
     select $1, conv.id, $2 || '-' || g,
            $3 || g || '@example.com',
            array[$4]::text[],
            now() - (g || ' minutes')::interval,
            'hi', false, false
       from conv, generate_series(1, $5::int) g`,
    [accountId, prefix, prefix, `${prefix}@example.com`, count],
  );
}

async function withNextRequest<T>(
  headers: Headers,
  fn: () => Promise<T>,
): Promise<T> {
  const { RequestCookies } = await import(
    "next/dist/server/web/spec-extension/cookies.js"
  );
  const { workAsyncStorageInstance } = await import(
    "next/dist/server/app-render/work-async-storage-instance.js"
  );
  const { workUnitAsyncStorageInstance } = await import(
    "next/dist/server/app-render/work-unit-async-storage-instance.js"
  );
  const workStore = {
    route: "/api/v3/contacts",
    forceStatic: false,
    dynamicShouldError: false,
  };
  const workUnit = {
    type: "request" as const,
    phase: "render",
    headers,
    cookies: new RequestCookies(headers),
  };
  return workAsyncStorageInstance.run(workStore, () =>
    workUnitAsyncStorageInstance.run(workUnit, fn),
  );
}

async function sessionCookie(email: string): Promise<string> {
  const token = await encode({
    secret: TEST_AUTH_SECRET,
    salt: SESSION_COOKIE,
    token: { email, sub: email },
  });
  return `${SESSION_COOKIE}=${token}`;
}

const failures: string[] = [];
function check(label: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
  }
}

const db = await startTestDb();
const tracked = trackQueries(db.pool);

try {
  const { GET } = await import("../src/app/api/v3/contacts/route.ts");

  const owner = "colleague@rditrials.com";
  const userA = await upsertUser(owner);
  const accountA = await upsertAccount({
    userId: userA,
    provider: "google",
    email: owner,
  });
  const userB = await upsertUser("other@rditrials.com");
  const accountB = await upsertAccount({
    userId: userB,
    provider: "google",
    email: "other@rditrials.com",
  });

  await seedMailbox(db.pool, accountA, "a-hist", MAILBOX_MESSAGES);
  await seedMailbox(db.pool, accountB, "b-hist", MAILBOX_MESSAGES);
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, snippet, is_unread, is_outgoing)
     select $1, c.id, 'recent-correspondent',
            'recent-correspondent@example.com',
            array[$2]::text[],
            now(), 'hi', false, false
       from seer.conversations c
      where c.account_id = $1 and c.provider_conversation_id = 'a-hist'`,
    [accountA, owner],
  );

  const cookie = await sessionCookie(owner);

  async function callContacts(input: {
    origin: string | null;
    query?: string;
    cookie?: string | null;
  }): Promise<Response> {
    const url = new URL("/api/v3/contacts", APP_ORIGIN);
    if (input.query !== undefined) url.searchParams.set("q", input.query);
    const headers = new Headers();
    headers.set("host", "mail.example.test");
    headers.set("x-forwarded-proto", "https");
    if (input.origin !== null) headers.set("origin", input.origin);
    if (input.cookie) headers.set("cookie", input.cookie);
    const before = tracked.calls.length;
    const response = await withNextRequest(headers, () => GET(new Request(url, { headers })));
    return Object.assign(response, { queriesFrom: before });
  }

  function queriesSince(response: Response): QueryCall[] {
    const from = (response as Response & { queriesFrom: number }).queriesFrom;
    return tracked.calls.slice(from);
  }

  async function assertBoundedSuggestions(label: string, query: string) {
    const before = tracked.calls.length;
    const suggestions = await suggestContacts(accountA, query);
    const issued = suggestionQueries(tracked.calls.slice(before));
    assert.ok(issued.length >= 1, `${label}: suggestion query did not run`);
    for (const call of issued) {
      const examined = await rowsExaminedBy(db.pool, call);
      check(label, () => {
        assert.ok(
          examined <= MAX_MESSAGE_ROWS_EXAMINED,
          `${label}: examined ${examined} seer.messages rows; cap is ${MAX_MESSAGE_ROWS_EXAMINED}`,
        );
      });
    }
    if (query === "recent-correspondent") {
      assert.ok(
        suggestions.some((row) => row.email === "recent-correspondent@example.com"),
        `${label}: recent correspondent missing from bounded suggestions`,
      );
    }
    assert.ok(suggestions.length <= 8, `${label}: default page is larger than 8`);
    assert.ok(
      suggestions.every((row) => !row.email.startsWith("b-hist")),
      `${label}: another mailbox's address was suggested`,
    );
  }

  // Two calls: repetition must stay bounded on each call, not only the first.
  await assertBoundedSuggestions("suggestContacts recent", "recent-correspondent");
  await assertBoundedSuggestions("suggestContacts repeat", "recent-correspondent");
  await assertBoundedSuggestions("suggestContacts empty query", "");

  async function assertRefusedBeforeQuery(
    label: string,
    input: { origin: string | null; query?: string; cookie?: string | null },
    status: number,
  ) {
    const response = await callContacts(input);
    const issued = queriesSince(response);
    check(label, () => {
      assert.equal(response.status, status, `${label}: status ${response.status}`);
      assert.equal(
        issued.length,
        0,
        `${label}: refused request still ran ${issued.length} database quer${issued.length === 1 ? "y" : "ies"}: ${issued
          .map((call) => call.text.slice(0, 80).replace(/\s+/g, " "))
          .join(" | ")}`,
      );
    });
  }

  process.env.NODE_ENV = "production";
  await assertRefusedBeforeQuery(
    "production cross-site origin",
    { origin: "https://evil.example", query: "recent-correspondent", cookie },
    403,
  );
  await assertRefusedBeforeQuery(
    "production missing origin",
    { origin: null, query: "recent-correspondent", cookie },
    403,
  );
  await assertRefusedBeforeQuery(
    "production null origin",
    { origin: "null", query: "a", cookie },
    403,
  );
  await assertRefusedBeforeQuery(
    "production unsigned",
    { origin: APP_ORIGIN, query: "recent-correspondent", cookie: null },
    404,
  );

  const sameOrigin = await callContacts({
    origin: APP_ORIGIN,
    query: "recent-correspondent",
    cookie,
  });
  assert.equal(sameOrigin.status, 200, "same-origin signed-in GET");
  const sameOriginBody = (await sameOrigin.json()) as {
    suggestions?: Array<{ email: string }>;
  };
  const sameOriginQueries = suggestionQueries(queriesSince(sameOrigin));
  assert.ok(sameOriginQueries.length >= 1, "same-origin GET did not suggest");
  for (const call of sameOriginQueries) {
    const examined = await rowsExaminedBy(db.pool, call);
    check("same-origin GET bound", () => {
      assert.ok(
        examined <= MAX_MESSAGE_ROWS_EXAMINED,
        `same-origin GET examined ${examined} seer.messages rows`,
      );
    });
  }
  assert.ok(
    sameOriginBody.suggestions?.some(
      (row) => row.email === "recent-correspondent@example.com",
    ),
    "same-origin GET dropped the recent correspondent",
  );

  const oversized = "a".repeat(MAX_QUERY_CHARS + 1);
  await assertRefusedBeforeQuery(
    "oversized search",
    { origin: APP_ORIGIN, query: oversized, cookie },
    400,
  );

  process.env.NODE_ENV = "test";
  await assertRefusedBeforeQuery(
    "non-production cross-site origin",
    { origin: "https://evil.example", query: "recent-correspondent", cookie },
    403,
  );

  const localTool = await callContacts({
    origin: null,
    query: "recent-correspondent",
    cookie,
  });
  assert.equal(localTool.status, 200, "non-production missing origin stays allowed");
  const localQueries = suggestionQueries(queriesSince(localTool));
  for (const call of localQueries) {
    const examined = await rowsExaminedBy(db.pool, call);
    check("non-production GET bound", () => {
      assert.ok(
        examined <= MAX_MESSAGE_ROWS_EXAMINED,
        `non-production GET examined ${examined} seer.messages rows`,
      );
    });
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log("v3-contacts-aggregation-dos: OK");
} finally {
  tracked.restore();
  await db.stop();
  if (previousEnv.AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousEnv.AUTH_SECRET;
  if (previousEnv.AUTH_URL === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = previousEnv.AUTH_URL;
  if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv.NODE_ENV;
}
