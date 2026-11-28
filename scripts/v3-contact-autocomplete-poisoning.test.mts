/**
 * Recipient autocomplete must not let inbound mail outrank people the mailbox
 * has actually written to.
 *
 * These tests fail while suggestContacts counts every from_email and every
 * to_emails entry, including messages with is_outgoing = false. They pass
 * when the exchanges count is built only from recipients on mail the mailbox
 * sent. An address that appears only on inbound mail may be omitted, or it
 * may stay in the list, but it must not rank above an address the user has
 * written to, and its exchanges value must not grow because of inbound mail.
 *
 * The product path under test is the one compose uses:
 *   provider payload → syncFolder → seer.messages → suggestContacts
 *   → addRecipient (the click in RecipientInput, ComposePane, and InlineReply)
 * GET /api/v3/contacts returns that array without reordering. The legacy
 * GET /api/contacts scorer is a different function and is not covered here.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { suggestContacts } from "../src/lib/v3/contacts/repository.ts";
import { addRecipient } from "../src/components/v3/recipient-state.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { ContactSuggestion } from "../src/lib/v3/contacts/types.ts";

const GMAIL_SELF = "counsel@firm.example";
const GRAPH_SELF = "lawyer@firm.example";

type Folder = "inbox" | "sent";

type GmailRaw = {
  id: string;
  folder: Folder;
  from: string;
  to: string[];
  cc: string[];
};

type GraphRaw = {
  id: string;
  folder: Folder;
  from: string;
  to: string[];
};

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gmailFixture(): GmailRaw[] {
  const rows: GmailRaw[] = [];
  const push = (folder: Folder, from: string, to: string[], cc: string[] = []) => {
    rows.push({ id: `${folder}-${rows.length + 1}`, folder, from, to, cc });
  };

  // Real colleagues, written from the mailbox. No people-graph row.
  for (let i = 0; i < 3; i++) push("sent", GMAIL_SELF, ["jane.doe@firm.example"]);
  for (let i = 0; i < 2; i++) push("sent", GMAIL_SELF, ["alex.chen@firm.example"]);
  for (let i = 0; i < 4; i++) push("sent", GMAIL_SELF, ["morgan.lee@firm.example"]);
  push("sent", GMAIL_SELF, ["priya.shah@firm.example"]);

  // Lookalike the user has never written to, repeated as inbound From.
  for (let i = 0; i < 12; i++) {
    push("inbox", "Jane Doe <jane.doe@f1rm.example>", [GMAIL_SELF]);
  }
  // Lookalike that appears only in the To list of someone else's mail.
  for (let i = 0; i < 10; i++) {
    push("inbox", "notices@elsewhere.test", [
      GMAIL_SELF,
      "Alex Chen <alex.chen@f1rm.example>",
    ]);
  }
  // One real send to a lookalike, then a pile of inbound mail from them.
  push("sent", GMAIL_SELF, ["morgan.lee@f1rm.example"]);
  for (let i = 0; i < 20; i++) {
    push("inbox", "morgan.lee@f1rm.example", [GMAIL_SELF]);
  }
  // Lookalike only on inbound Cc. Cc is not a sent-recipient signal.
  for (let i = 0; i < 8; i++) {
    push("inbox", "notices@elsewhere.test", [GMAIL_SELF], ["priya.shah@f1rm.example"]);
  }
  return rows;
}

function graphFixture(): GraphRaw[] {
  const rows: GraphRaw[] = [];
  const push = (folder: Folder, from: string, to: string[]) => {
    rows.push({ id: `${folder}-g-${rows.length + 1}`, folder, from, to });
  };
  for (let i = 0; i < 3; i++) push("sent", GRAPH_SELF, ["riley.nguyen@firm.example"]);
  for (let i = 0; i < 12; i++) {
    push("inbox", "riley.nguyen@f1rm.example", [GRAPH_SELF]);
  }
  return rows;
}

function gmailFetch(rows: GmailRaw[]): typeof fetch {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/threads")) {
      const query = url.searchParams.get("q") ?? "";
      const folder: Folder | null = query.includes("in:sent")
        ? "sent"
        : query.includes("in:inbox")
          ? "inbox"
          : null;
      const threads = folder ? rows.filter((row) => row.folder === folder) : [];
      return json({
        threads: threads.map((row) => ({ id: row.id })),
        resultSizeEstimate: threads.length,
      });
    }
    const threadId = url.pathname.split("/threads/")[1];
    const row = threadId ? byId.get(decodeURIComponent(threadId)) : undefined;
    if (!row) return json({ error: { message: "missing thread" } }, 404);
    return json({
      id: row.id,
      messages: [
        {
          id: row.id,
          threadId: row.id,
          snippet: "hello",
          labelIds: row.folder === "sent" ? ["SENT"] : ["INBOX"],
          internalDate: "1700000000000",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: row.from },
              { name: "To", value: row.to.join(", ") },
              { name: "Cc", value: row.cc.join(", ") },
              { name: "Subject", value: "Note" },
            ],
            body: { size: 5, data: b64url("hello") },
          },
        },
      ],
    });
  }) as typeof fetch;
}

function graphMessage(row: GraphRaw) {
  return {
    id: row.id,
    conversationId: row.id,
    subject: "Note",
    from: { emailAddress: { address: row.from, name: row.from } },
    toRecipients: row.to.map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    receivedDateTime: "2026-08-01T10:00:00Z",
    bodyPreview: "hello",
    body: { contentType: "text", content: "hello" },
    isRead: true,
    hasAttachments: false,
  };
}

function graphFetch(rows: GraphRaw[]): typeof fetch {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const href = url.href;
    if (href.includes("/mailFolders/inbox/messages") || href.includes("/mailFolders/sentitems/messages")) {
      const folder: Folder = href.includes("sentitems") ? "sent" : "inbox";
      const page = rows.filter((row) => row.folder === folder).map(graphMessage);
      return json({ value: page, "@odata.count": page.length });
    }
    if (href.includes("conversationId")) {
      const filter = decodeURIComponent(url.searchParams.get("$filter") ?? href);
      const id = /conversationId eq '([^']+)'/.exec(filter)?.[1];
      const row = id ? byId.get(id) : undefined;
      return json({ value: row ? [graphMessage(row)] : [] });
    }
    if (href.includes("/mailFolders/")) {
      return json({ totalItemCount: rows.length });
    }
    return json({ error: { message: "unexpected graph url" } }, 404);
  }) as typeof fetch;
}

function listed(rows: ContactSuggestion[]): string {
  return rows.map((row) => `${row.email}(${row.exchanges})`).join(", ");
}

/**
 * `expectedLookalike` is how many times the mailbox itself addressed that
 * person. Zero means the address exists only on inbound mail: dropping it is
 * fine, and so is keeping it at the bottom with an exchanges count of 0.
 */
function assertNotPoisoned(
  rows: ContactSuggestion[],
  realEmail: string,
  lookalikeEmail: string,
  expectedReal: number,
  expectedLookalike: number,
): void {
  const real = rows.find((row) => row.email === realEmail);
  assert.ok(real, `${realEmail} missing from [${listed(rows)}]`);
  assert.equal(
    real.exchanges,
    expectedReal,
    `${realEmail} exchanges must count mail the mailbox sent, got ${real.exchanges}`,
  );
  assert.equal(real.tier, "unknown");
  assert.equal(real.vip, false);

  const lookalike = rows.find((row) => row.email === lookalikeEmail);
  if (!lookalike) {
    assert.equal(
      expectedLookalike,
      0,
      `${lookalikeEmail} was written to ${expectedLookalike} time(s) and must stay suggestable`,
    );
    return;
  }
  assert.equal(
    lookalike.exchanges,
    expectedLookalike,
    `${lookalikeEmail} exchanges include inbound mail (${lookalike.exchanges}, want ${expectedLookalike}) in [${listed(rows)}]`,
  );
  const realIndex = rows.findIndex((row) => row.email === realEmail);
  const lookalikeIndex = rows.findIndex((row) => row.email === lookalikeEmail);
  assert.ok(
    realIndex < lookalikeIndex,
    `${lookalikeEmail} ranks above ${realEmail} in [${listed(rows)}]`,
  );
}

const db = await startTestDb();
try {
  const gmailRows = gmailFixture();
  const userId = await upsertUser(GMAIL_SELF);
  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: GMAIL_SELF,
  });
  const gmail = new GmailProvider({
    accessToken: "test-token",
    accountEmail: GMAIL_SELF,
    fetchImpl: gmailFetch(gmailRows),
  });
  const sentRun = await syncFolder(gmailAccount, gmail, "sent", "full");
  const inboxRun = await syncFolder(gmailAccount, gmail, "inbox", "full");
  assert.equal(sentRun.coverage.failed, 0);
  assert.equal(inboxRun.coverage.failed, 0);

  const stored = await db.pool.query<{
    from_email: string | null;
    is_outgoing: boolean;
    to_emails: string[];
  }>(
    `select from_email, is_outgoing, to_emails
       from seer.messages
      where account_id = $1`,
    [gmailAccount],
  );
  const lookalikeInbound = stored.rows.filter(
    (row) => row.from_email === "jane.doe@f1rm.example",
  );
  assert.equal(lookalikeInbound.length, 12);
  assert.ok(lookalikeInbound.every((row) => row.is_outgoing === false));
  const realSent = stored.rows.filter(
    (row) =>
      row.is_outgoing === true &&
      (row.to_emails ?? []).includes("jane.doe@firm.example"),
  );
  assert.equal(realSent.length, 3);

  const people = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.people where account_id = $1`,
    [gmailAccount],
  );
  assert.equal(people.rows[0].n, 0, "sync must not invent a people tier");

  const jane = await suggestContacts(gmailAccount, "jane.doe");
  assertNotPoisoned(jane, "jane.doe@firm.example", "jane.doe@f1rm.example", 3, 0);
  // Clicking the top suggestion is what RecipientInput commits into compose.
  const clicked = addRecipient([], {
    email: jane[0].email,
    displayName: jane[0].displayName,
  });
  assert.equal(clicked[0].email, "jane.doe@firm.example");

  const alex = await suggestContacts(gmailAccount, "alex.chen");
  assertNotPoisoned(alex, "alex.chen@firm.example", "alex.chen@f1rm.example", 2, 0);

  const morgan = await suggestContacts(gmailAccount, "morgan.lee");
  assertNotPoisoned(
    morgan,
    "morgan.lee@firm.example",
    "morgan.lee@f1rm.example",
    4,
    1,
  );

  // Inbound Cc is already ignored. Keep the case so a fix cannot start
  // counting recipient lists the mailbox did not write.
  const priya = await suggestContacts(gmailAccount, "priya.shah");
  assertNotPoisoned(priya, "priya.shah@firm.example", "priya.shah@f1rm.example", 1, 0);

  const graphRows = graphFixture();
  const graphUser = await upsertUser(GRAPH_SELF);
  const graphAccount: AccountId = await upsertAccount({
    userId: graphUser,
    provider: "microsoft",
    email: GRAPH_SELF,
  });
  const outlook = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: GRAPH_SELF,
    fetchImpl: graphFetch(graphRows),
  });
  const graphSent = await syncFolder(graphAccount, outlook, "sent", "full");
  const graphInbox = await syncFolder(graphAccount, outlook, "inbox", "full");
  assert.equal(graphSent.coverage.failed, 0);
  assert.equal(graphInbox.coverage.failed, 0);

  const riley = await suggestContacts(graphAccount, "riley.nguyen");
  assertNotPoisoned(
    riley,
    "riley.nguyen@firm.example",
    "riley.nguyen@f1rm.example",
    3,
    0,
  );

  console.log("v3-contact-autocomplete-poisoning: OK");
} finally {
  await db.stop();
}
