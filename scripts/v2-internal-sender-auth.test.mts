/**
 * Spec: a From domain is not proof the sender is inside the organization.
 *
 * These assertions fail while that proof is still the domain comparison.
 * A stranger at the same freemail domain as the desk, and a company-domain
 * From the provider stored without a passing authentication result, must not
 * be labeled internal, must not be described to the model as inside the
 * organization, and must not be filed as live work or kept solely for that
 * reason. The tests follow sync → stored From → context → safety → reader
 * and the reading pane.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { OWNER_EMAIL } from "../src/lib/auth/org.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { clearContextInputCache } from "../src/lib/v2/intelligence/context-loader.ts";
import { loadContextInput } from "../src/lib/v2/intelligence/context-loader.ts";
import { readConversation, type ReaderModelInput } from "../src/lib/v2/intelligence/reader.ts";
import { CHIEF_OF_STAFF_SYSTEM, escalationReasons } from "../src/lib/v2/intelligence/model.ts";
import { counterpartyOf } from "../src/lib/v2/intelligence/matter-key.ts";
import { suggestMattersForConversation } from "../src/lib/v2/intelligence/user-matter.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { participants, shapeThread, summariseThread } from "../src/lib/v3/reader/thread-shape.ts";
import { Reader } from "../src/components/v2/Reader.tsx";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";

const COMPANY = "exec@rditrials.com";
const GMAIL_STRANGER = "pat.stranger@gmail.com";
const GMAIL_NOISE = "noise.list@gmail.com";
const GMAIL_JOIN = "other.person@gmail.com";
const FORGED = "attacker@rditrials.com";
const FORGED_NOISE = "bounce@rditrials.com";
const KNOWN = "lara@rditrials.com";
const WHEN = "2026-11-18T15:04:00.000Z";

const ASK = "Please countersign the booth contract before Friday.";
const JOIN = "The vendor agreement signature is still waiting on you.";
const NOISE = "Ten percent off selected items this weekend.";
const KNOWN_BODY = "The lab supply order needs your approval before Friday.";

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailThread(
  id: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  authentication: string | null,
) {
  const headers = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
  ];
  if (authentication) {
    headers.push({ name: "Authentication-Results", value: authentication });
  }
  return {
    id,
    messages: [
      {
        id: `${id}-m1`,
        threadId: id,
        snippet: body.slice(0, 80),
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.parse(WHEN)),
        payload: {
          headers,
          mimeType: "text/plain",
          body: { size: body.length, data: b64url(body) },
        },
      },
    ],
  };
}

const GMAIL_THREADS = {
  "gmail-ask": gmailThread(
    "gmail-ask",
    `Pat Stranger <${GMAIL_STRANGER}>`,
    OWNER_EMAIL,
    "Please countersign the booth contract",
    ASK,
    "mx.google.com; spf=pass smtp.mailfrom=pat.stranger@gmail.com; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com",
  ),
  "gmail-join": gmailThread(
    "gmail-join",
    `Other Person <${GMAIL_JOIN}>`,
    OWNER_EMAIL,
    "Vendor agreement signature",
    JOIN,
    "mx.google.com; spf=pass smtp.mailfrom=other.person@gmail.com; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com",
  ),
  "gmail-noise": gmailThread(
    "gmail-noise",
    GMAIL_NOISE,
    OWNER_EMAIL,
    "Weekend coupon roundup",
    NOISE,
    null,
  ),
};

function gmailFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/threads?") && u.includes("in%3Ainbox")) {
      return json({
        threads: Object.keys(GMAIL_THREADS).map((id) => ({ id })),
        resultSizeEstimate: Object.keys(GMAIL_THREADS).length,
      });
    }
    const threadGet = u.match(/\/threads\/([^?]+)\?format=full/);
    if (threadGet) {
      const id = decodeURIComponent(threadGet[1]);
      const thread = GMAIL_THREADS[id as keyof typeof GMAIL_THREADS];
      if (!thread) return new Response("missing", { status: 404 });
      return json(thread);
    }
    throw new Error(`unexpected gmail request ${u}`);
  }) as typeof fetch;
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { address: string; name?: string } };
  toRecipients: { emailAddress: { address: string } }[];
  ccRecipients: [];
  receivedDateTime: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  isRead: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
};

function graphMessage(
  id: string,
  from: string,
  name: string | undefined,
  subject: string,
  body: string,
  authentication: string | null,
): GraphMessage {
  const message: GraphMessage = {
    id,
    conversationId: id,
    subject,
    from: { emailAddress: { address: from, name } },
    toRecipients: [{ emailAddress: { address: COMPANY } }],
    ccRecipients: [],
    receivedDateTime: WHEN,
    bodyPreview: body.slice(0, 80),
    body: { contentType: "text", content: body },
    isRead: false,
  };
  if (authentication) {
    message.internetMessageHeaders = [
      { name: "Authentication-Results", value: authentication },
    ];
  }
  return message;
}

const GRAPH_MESSAGES: Record<string, GraphMessage> = {
  "forge-ask": graphMessage(
    "forge-ask",
    FORGED,
    "Alex Colleague",
    "Please countersign the booth contract",
    ASK,
    "spf=fail smtp.mailfrom=attacker.example; dkim=fail; dmarc=fail header.from=rditrials.com",
  ),
  "forge-join": graphMessage(
    "forge-join",
    FORGED,
    "Alex Colleague",
    "Vendor agreement signature",
    JOIN,
    "spf=fail smtp.mailfrom=attacker.example; dkim=fail; dmarc=fail header.from=rditrials.com",
  ),
  "forge-noise": graphMessage(
    "forge-noise",
    FORGED_NOISE,
    undefined,
    "Weekend coupon roundup",
    NOISE,
    null,
  ),
  "known-ask": graphMessage(
    "known-ask",
    KNOWN,
    "Lara Bennett",
    "Lab supply order",
    KNOWN_BODY,
    "spf=fail; dkim=fail; dmarc=fail header.from=rditrials.com",
  ),
};

function outlookFetch(): typeof fetch {
  return (async (url: string) => {
    const u = decodeURIComponent(String(url));
    if (u.includes("/mailFolders/inbox/messages")) {
      return json({
        "@odata.count": Object.keys(GRAPH_MESSAGES).length,
        value: Object.values(GRAPH_MESSAGES),
      });
    }
    const filter = u.match(/conversationId eq '([^']+)'/);
    if (filter) {
      const message = GRAPH_MESSAGES[filter[1]];
      if (!message) return json({ value: [] });
      return json({ value: [message] });
    }
    throw new Error(`unexpected outlook request ${u}`);
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const matterProposal = (matterRef: string, ask: string): ReadResult => ({
  home: "matter",
  summary: matterRef,
  rationale: "The model treated the ask as live work.",
  owner: "you",
  ask,
  obligation: false,
  matterRef,
  yields: [],
  evidence: [],
});

const disposable: ReadResult = {
  home: "delete",
  summary: "Coupon roundup",
  rationale: "No work in it.",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

type Seen = {
  contextText: string;
  routing: ReaderModelInput["routingFacts"];
};

function capturingModel(result: ReadResult, seen: Seen) {
  return async (input: ReaderModelInput) => {
    seen.contextText = input.contextText;
    seen.routing = input.routingFacts;
    return result;
  };
}

async function conversationId(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, providerId],
  );
  assert.equal(row.rowCount, 1, `synced conversation ${providerId}`);
  return row.rows[0].id;
}

function visibleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

const db = await startTestDb();
try {
  assert.match(
    CHIEF_OF_STAFF_SYSTEM,
    /\[explicit\]\/\[system\] outrank your reading/,
    "a system context line is defined to outrank the email",
  );

  const userId = await upsertUser(OWNER_EMAIL);
  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: OWNER_EMAIL,
  });
  const companyAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: COMPANY,
  });

  const gmailRun = await syncAccount(
    gmailAccount,
    new GmailProvider({
      accessToken: "test-access-token",
      accountEmail: OWNER_EMAIL,
      fetchImpl: gmailFetch(),
    }),
    "full",
  );
  assert.equal(gmailRun.coverage.failed, 0, "gmail sync stored the inbox");
  const outlookRun = await syncAccount(
    companyAccount,
    new OutlookProvider({
      accessToken: "test-access-token",
      accountEmail: COMPANY,
      fetchImpl: outlookFetch(),
    }),
    "full",
  );
  assert.equal(outlookRun.coverage.failed, 0, "outlook sync stored the inbox");

  const storedForged = await db.pool.query<{ from_email: string }>(
    `select m.from_email
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where c.account_id = $1 and c.provider_conversation_id = 'forge-ask'`,
    [companyAccount],
  );
  assert.equal(
    storedForged.rows[0]?.from_email,
    FORGED,
    "sync keeps the From address the provider delivered",
  );

  await db.pool.query(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Vendor agreement signature', 'internal', 'inferred'),
            ($2, 'Vendor agreement signature', 'internal', 'inferred')`,
    [gmailAccount, companyAccount],
  );
  await db.pool.query(
    `insert into seer.people (account_id, email, display_name, tier, vip)
     values ($1, $2, 'Lara Bennett', 'known', false)`,
    [companyAccount, KNOWN],
  );
  clearContextInputCache();

  const gmailContext = await loadContextInput(gmailAccount, OWNER_EMAIL);
  assert.equal(gmailContext.ownDomain, "gmail.com");
  assert.equal(gmailContext.people.length, 0);
  const companyContext = await loadContextInput(companyAccount, COMPANY);
  assert.equal(companyContext.ownDomain, "rditrials.com");

  async function read(
    accountId: AccountId,
    providerId: string,
    context: typeof gmailContext,
    result: ReadResult,
  ) {
    const seen: Seen = {
      contextText: "",
      routing: {
        senderIsKnown: false,
        senderIsInternal: false,
        liveMatterId: null,
        addressedDirectly: false,
      },
    };
    const id = await conversationId(db.pool, accountId, providerId);
    const before = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.matters where account_id = $1",
      [accountId],
    );
    const decision = await readConversation({
      accountId,
      conversationId: asConversationId(id),
      conversation: (await getCorpusConversation(
        accountId,
        id,
        accountId === gmailAccount ? "google" : "microsoft",
      ))!.conversation,
      context,
      model: capturingModel(result, seen),
    });
    const links = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.matter_conversations
        where conversation_id = $1`,
      [id],
    );
    const after = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.matters where account_id = $1",
      [accountId],
    );
    return { seen, decision, id, links: links.rows[0].n, before: before.rows[0].n, after: after.rows[0].n };
  }

  function assertNotOrganization(seen: Seen, label: string) {
    assert.equal(seen.routing.senderIsInternal, false, `${label}: not an internal sender`);
    assert.equal(
      seen.contextText.includes("[system] sender is inside your organization"),
      false,
      `${label}: no system line from the From domain`,
    );
    assert.equal(
      escalationReasons(
        { ...disposable },
        {
          accountId: gmailAccount,
          conversationId: asConversationId("00000000-0000-0000-0000-000000000000"),
          conversation: { providerConversationId: "x", subject: "", messages: [], lastMessageAt: "" },
          contextText: seen.contextText,
          routingFacts: seen.routing,
        },
      ).includes("delete_internal_sender"),
      false,
      `${label}: domain match is not a delete-protection signal`,
    );
  }

  // A real Gmail sender, authenticated by the provider as gmail.com, is still
  // not inside an organization. Passing DMARC does not make the consumer
  // domain a company.
  {
    const fresh = await read(
      gmailAccount,
      "gmail-ask",
      gmailContext,
      matterProposal("Booth contract countersignature", ASK),
    );
    assertNotOrganization(fresh.seen, "gmail stranger");
    assert.equal(fresh.seen.routing.senderIsKnown, false);
    assert.equal(fresh.seen.routing.liveMatterId, null);
    assert.equal(fresh.decision.home, "record");
    assert.ok(fresh.decision.vetoReasons.includes("matter_untrusted_sender"));
    assert.equal(fresh.links, 0);
    assert.equal(fresh.after, fresh.before, "no Atlas matter was created");
  }

  // Same desk, and the ask shares its name with a live internal matter. Domain
  // equality must not continue that matter and skip the untrusted-sender gate.
  {
    const joined = await read(
      gmailAccount,
      "gmail-join",
      gmailContext,
      matterProposal("Vendor agreement signature", JOIN),
    );
    assertNotOrganization(joined.seen, "gmail continuation");
    assert.equal(joined.seen.routing.liveMatterId, null);
    assert.equal(joined.decision.home, "record");
    assert.ok(joined.decision.vetoReasons.includes("matter_untrusted_sender"));
    assert.equal(joined.links, 0);
    assert.equal(joined.after, joined.before);
    const suggestions = await suggestMattersForConversation(
      gmailAccount,
      asConversationId(joined.id),
    );
    assert.equal(
      suggestions.some((item) => item.related),
      false,
      "a gmail stranger is not suggested as related internal work",
    );
  }

  {
    const dropped = await read(gmailAccount, "gmail-noise", gmailContext, disposable);
    assertNotOrganization(dropped.seen, "gmail noise");
    assert.equal(dropped.decision.home, "delete");
    assert.equal(dropped.decision.vetoReasons.includes("internal_sender"), false);
  }

  // Company mailbox. The provider payload carried a failing authentication
  // result (and, for the coupon, no result at all). The stored From is the
  // only signal the read sees today.
  {
    const fresh = await read(
      companyAccount,
      "forge-ask",
      companyContext,
      matterProposal("Booth contract countersignature", ASK),
    );
    assertNotOrganization(fresh.seen, "forged company From");
    assert.equal(fresh.seen.routing.senderIsKnown, false);
    assert.equal(fresh.decision.home, "record");
    assert.ok(fresh.decision.vetoReasons.includes("matter_untrusted_sender"));
    assert.equal(fresh.links, 0);
    assert.equal(fresh.after, fresh.before);
  }

  {
    const joined = await read(
      companyAccount,
      "forge-join",
      companyContext,
      matterProposal("Vendor agreement signature", JOIN),
    );
    assertNotOrganization(joined.seen, "forged continuation");
    assert.equal(joined.seen.routing.liveMatterId, null);
    assert.equal(joined.decision.home, "record");
    assert.ok(joined.decision.vetoReasons.includes("matter_untrusted_sender"));
    assert.equal(joined.links, 0);
    const suggestions = await suggestMattersForConversation(
      companyAccount,
      asConversationId(joined.id),
    );
    assert.equal(
      suggestions.some((item) => item.related),
      false,
      "an unauthenticated company-domain From is not related internal work",
    );
    const view = await buildInboxView(companyAccount, "microsoft");
    const row = view.records.find((item) => item.conversationId === joined.id);
    assert.ok(row, "the ask stays in the reversible archive list");
    assert.notEqual(row?.counterparty, "Internal");
    assert.equal(
      view.atlas.some((card) =>
        card.conversations.some((item) => item.conversationId === joined.id),
      ),
      false,
    );
  }

  {
    const dropped = await read(companyAccount, "forge-noise", companyContext, disposable);
    assertNotOrganization(dropped.seen, "unauthenticated company noise");
    assert.equal(dropped.decision.home, "delete");
    assert.equal(dropped.decision.vetoReasons.includes("internal_sender"), false);
  }

  // A person already on this mailbox is still allowed through the known-sender
  // path. That must keep working when domain equality stops counting.
  {
    const known = await read(
      companyAccount,
      "known-ask",
      companyContext,
      matterProposal("Lab supply order", KNOWN_BODY),
    );
    assert.equal(known.seen.routing.senderIsKnown, true);
    assert.equal(
      known.seen.contextText.includes("[system] sender is inside your organization"),
      false,
      "a known person is not labeled internal from an unauthenticated From",
    );
    assert.equal(known.decision.home, "matter");
    assert.equal(known.decision.vetoReasons.includes("matter_untrusted_sender"), false);
  }

  async function assertPane(
    accountId: AccountId,
    providerId: string,
    provider: "google" | "microsoft",
    ownEmail: string,
    sender: string,
    label: string,
  ) {
    const id = await conversationId(db.pool, accountId, providerId);
    const loaded = await getCorpusConversation(accountId, id, provider);
    assert.ok(loaded);
    const ownDomain = ownEmail.split("@")[1] ?? "";
    const lanes = shapeThread(loaded.conversation, ownDomain, ownEmail);
    assert.equal(lanes[0]?.kind, "turn", `${label}: not an internal branch`);
    assert.equal(summariseThread(loaded.conversation, ownDomain, ownEmail).internal, 0);
    const person = participants(loaded.conversation, ownDomain, ownEmail).find(
      (item) => item.email === sender,
    );
    assert.ok(person);
    assert.notEqual(person?.org, "internal");
    const html = visibleText(
      renderToString(
        createElement(Reader, {
          provider,
          conversation: loaded.conversation,
          ownEmail,
          onReply() {},
          onReplyAll() {},
          onForward() {},
          onArchive() {},
          onDelete() {},
        }),
      ),
    );
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /INTERNAL/);
    assert.doesNotMatch(html, /inside your organization/i);
  }

  await assertPane(
    gmailAccount,
    "gmail-ask",
    "google",
    OWNER_EMAIL,
    GMAIL_STRANGER,
    "Pat Stranger",
  );
  await assertPane(
    companyAccount,
    "forge-ask",
    "microsoft",
    COMPANY,
    FORGED,
    "Alex Colleague",
  );

  // Freemail domains the counterparty helper already refuses when they are
  // someone else's domain. They are still not an organization when the
  // mailbox itself is on that domain.
  for (const domain of [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ]) {
    assert.notEqual(
      counterpartyOf(`stranger@${domain}`, domain),
      "internal",
      `${domain} is not an organization just because the mailbox is there`,
    );
  }

  console.log("v2-internal-sender-auth: OK");
} finally {
  await db.stop();
}
