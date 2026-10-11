/**
 * Gate: intelligence reads must not pull toasted body_html when body_text
 * exists, context packets must be reused within a tick, and the UI reader
 * still gets HTML for display.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { db } from "../src/lib/v2/db/pool.ts";
import {
  loadConversation,
  loadStoredConversations,
  MESSAGES_FOR_READ_SQL,
} from "../src/lib/v2/intelligence/load-conversation.ts";
import {
  clearContextInputCache,
  loadContextInput,
} from "../src/lib/v2/intelligence/context-loader.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { readableBody } from "../src/lib/v2/intelligence/html-text.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { Pool } from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUGE_HTML = `<html><head><style>.x{color:red}</style></head><body><p>${"A".repeat(40_000)}</p></body></html>`;

function captureSql(pool: Pool): { sqls: string[]; restore: () => void } {
  const sqls: string[] = [];
  const original = pool.query.bind(pool);
  const wrapped = ((query: unknown, values?: unknown) => {
    if (typeof query === "string") sqls.push(query);
    else if (query && typeof query === "object" && "text" in query) {
      sqls.push(String((query as { text: string }).text));
    }
    return original(query as never, values as never);
  }) as typeof pool.query;
  pool.query = wrapped;
  return {
    sqls,
    restore: () => {
      pool.query = original as typeof pool.query;
    },
  };
}

assert.match(
  MESSAGES_FOR_READ_SQL,
  /case when nullif\(btrim\(coalesce\(m\.body_text, ''\)\), ''\) is not null/,
);
assert.match(MESSAGES_FOR_READ_SQL, /else m\.body_html/);
assert.doesNotMatch(
  MESSAGES_FOR_READ_SQL.replace(/case when[\s\S]*?end as body_html/, "case_omitted"),
  /\bbody_html\b/,
  "body_html must only appear inside the CASE that omits it when text exists",
);

const readerSource = readFileSync(
  path.join(HERE, "../src/lib/v3/reader/repository.ts"),
  "utf8",
);
assert.match(
  readerSource,
  /body_html, body_text, snippet/,
  "the UI reader must still select body_html for display",
);
assert.doesNotMatch(
  readerSource,
  /case when nullif\(btrim/,
  "the UI reader must not strip body_html",
);

const dbh = await startTestDb();
try {
  const userId = await upsertUser("egress@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "egress@example.com",
  });

  async function seedMessage(opts: {
    providerId: string;
    bodyHtml: string | null;
    bodyText: string | null;
  }): Promise<string> {
    const conv = await dbh.pool.query<{ id: string }>(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, folders, last_message_at)
       values ($1, $2, $2, array['inbox'], now())
       returning id`,
      [accountId, opts.providerId],
    );
    await dbh.pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, from_name,
          to_emails, sent_at, snippet, body_html, body_text, is_unread, is_outgoing)
       values ($1, $2, $3, 'sender@example.com', 'Sender', array['egress@example.com'],
               now(), 'snip', $4, $5, true, false)`,
      [accountId, conv.rows[0].id, `${opts.providerId}-m`, opts.bodyHtml, opts.bodyText],
    );
    return conv.rows[0].id;
  }

  const withText = await seedMessage({
    providerId: "has-text",
    bodyHtml: HUGE_HTML,
    bodyText: "Please countersign the CDA by Friday.",
  });
  const htmlOnly = await seedMessage({
    providerId: "html-only",
    bodyHtml: "<p>From html only.</p>",
    bodyText: null,
  });

  const spy = captureSql(dbh.pool);
  const loadedText = await loadConversation(withText);
  const loadedHtml = await loadConversation(htmlOnly);
  const stored = await loadStoredConversations(accountId as AccountId);
  spy.restore();

  assert.equal(loadedText?.messages[0]?.bodyHtml, null, "text path must not return HTML");
  assert.equal(
    loadedText?.messages[0]?.bodyText,
    "Please countersign the CDA by Friday.",
  );
  assert.equal(
    readableBody(loadedText!.messages[0]),
    "Please countersign the CDA by Friday.",
  );
  assert.equal(loadedHtml?.messages[0]?.bodyHtml, "<p>From html only.</p>");
  assert.equal(loadedHtml?.messages[0]?.bodyText, "From html only.");
  assert.equal(readableBody(loadedHtml!.messages[0]), "From html only.");

  const readSql = spy.sqls.filter((s) => /from seer\.messages/i.test(s));
  assert.ok(readSql.length >= 1, "expected a messages read");
  for (const sql of readSql) {
    assert.match(sql, /case when nullif\(btrim/);
  }
  assert.ok(
    spy.sqls.some((s) => /from seer\.conversations c/i.test(s) && /left join seer\.messages m/i.test(s)),
    "loadConversation must join conversation + messages in one round trip",
  );
  assert.ok(
    spy.sqls.some((s) => /conversation_id = any\(/i.test(s)),
    "shadow load must fetch all messages in one query",
  );
  assert.equal(stored.length, 2);

  const ui = await getCorpusConversation(accountId, withText, "google");
  assert.equal(ui?.conversation.messages[0]?.bodyHtml, HUGE_HTML);
  assert.equal(ui?.conversation.messages[0]?.bodyText, "Please countersign the CDA by Friday.");

  await dbh.pool.query(
    `insert into seer.people (account_id, email, tier, vip)
     values ($1, 'vip@example.com', 'inner', true)`,
    [accountId],
  );
  clearContextInputCache();
  const peopleSpy = captureSql(dbh.pool);
  const first = await loadContextInput(accountId, "egress@example.com");
  const second = await loadContextInput(accountId, "egress@example.com");
  peopleSpy.restore();
  const peopleQueries = peopleSpy.sqls.filter((s) =>
    /select email, tier, vip from seer\.people/i.test(s),
  );
  assert.equal(peopleQueries.length, 1, "people table must be cached within the TTL");
  assert.equal(first.people[0]?.email, "vip@example.com");
  assert.equal(second.people[0]?.email, "vip@example.com");

  const poolUsed = db();
  assert.equal(poolUsed, dbh.pool);

  console.log("v2-db-egress: OK");
} finally {
  await dbh.stop();
}
