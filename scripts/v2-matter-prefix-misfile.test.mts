/**
 * Spec for matter mis-filing from an unverified sender domain.
 *
 * An open matter whose counterparty is the first label of a company domain
 * (acme) and whose title shares two content words (pricing, renewal) must not
 * absorb a new inbox message just because the sender From header is
 * someone@acme.com or a prefix subdomain the strip list collapses to acme
 * (e, em, go, send, info, news). The read is the product path: provider sync
 * stores that From, readBatch classifies the inbox thread, and a model that
 * calls the thread a matter must still be held to the untrusted-sender,
 * direct-addressee, and open-ask checks. A direct human ask must not be
 * filed onto that existing matter either. Suggestion and unscoped placement
 * use the same tie and must not select it.
 *
 * These assertions fail while that tying is in place.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { clearContextInputCache } from "../src/lib/v2/intelligence/context-loader.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import {
  placeConversationOnMatter,
  suggestMattersForConversation,
} from "../src/lib/v2/intelligence/user-matter.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";

const OWN = "conall@rditrials.com";
const MATTER_TITLE = "Acme pricing renewal";

type Attack = {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Broadcast: promotion checks must refuse. Direct: a real ask still must not join Acme. */
  kind: "broadcast" | "direct" | "control";
};

const BROADCAST_BODY =
  "Distribution copy of the pricing renewal for the vendor list.";
const DIRECT_BODY = "Hi Conall, please confirm the pricing renewal.";
const VENDOR_TO = "Vendors <vendors@lists.example>";
const DIRECT_TO = "Conall <conall@rditrials.com>";

function attack(
  id: string,
  from: string,
  kind: Attack["kind"],
  subject = "pricing renewal",
): Attack {
  return {
    id,
    from,
    to: kind === "direct" ? DIRECT_TO : VENDOR_TO,
    subject,
    body: kind === "direct" ? DIRECT_BODY : BROADCAST_BODY,
    kind,
  };
}

/** Prefixes the strip list deletes, plus the bare company domain. */
const BROADCAST: Attack[] = [
  attack("b-e", "Notice <notice@e.acme.com>", "broadcast"),
  attack("b-em", "Notice <notice@em.acme.com>", "broadcast"),
  attack("b-go", "Notice <notice@go.acme.com>", "broadcast"),
  attack("b-send", "Notice <notice@send.acme.com>", "broadcast"),
  attack("b-info", "Notice <notice@info.acme.com>", "broadcast"),
  attack("b-news", "Notice <notice@news.acme.com>", "broadcast"),
  attack("b-exact", "Notice <notice@acme.com>", "broadcast"),
  attack(
    "b-other",
    "Notice <notice@e.notacme.com>",
    "control",
  ),
  attack("b-one-word", "Notice <solo@e.acme.com>", "control", "pricing schedule"),
];

const DIRECT: Attack[] = [
  attack("d-e", "Alex <alex@e.acme.com>", "direct"),
  attack("d-em", "Alex <alex@em.acme.com>", "direct"),
  attack("d-go", "Alex <alex@go.acme.com>", "direct"),
  attack("d-send", "Alex <alex@send.acme.com>", "direct"),
  attack("d-exact", "Alex <alex@acme.com>", "direct"),
];

const GMAIL_ATTACKS = [...BROADCAST, ...DIRECT];
const OUTLOOK_ATTACKS = [
  attack("o-b-go", "Notice <notice@go.acme.com>", "broadcast"),
  attack("o-d-e", "Alex <alex@e.acme.com>", "direct"),
];

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailFetch(attacks: Attack[]): typeof fetch {
  const threads = Object.fromEntries(
    attacks.map((item) => [
      item.id,
      {
        id: item.id,
        messages: [
          {
            id: `${item.id}-m1`,
            threadId: item.id,
            snippet: item.body.slice(0, 40),
            labelIds: ["INBOX", "UNREAD"],
            internalDate: "1750000000000",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: item.from },
                { name: "To", value: item.to },
                { name: "Subject", value: item.subject },
              ],
              body: { size: item.body.length, data: b64url(item.body) },
            },
          },
        ],
      },
    ]),
  );
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/threads?")) {
      return Response.json({
        threads: attacks.map((item) => ({ id: item.id })),
        resultSizeEstimate: attacks.length,
      });
    }
    const id = href.match(/\/threads\/([^/?]+)/)?.[1];
    const thread = id ? threads[decodeURIComponent(id)] : undefined;
    if (!thread) return new Response("missing", { status: 404 });
    return Response.json(thread);
  }) as typeof fetch;
}

function outlookMessage(item: Attack, withBody: boolean) {
  const address = item.from.match(/<([^>]+)>/)?.[1] ?? item.from;
  const toAddress = item.to.match(/<([^>]+)>/)?.[1] ?? item.to;
  return {
    id: `${item.id}-m1`,
    conversationId: item.id,
    subject: item.subject,
    from: { emailAddress: { address, name: "Sender" } },
    toRecipients: [{ emailAddress: { address: toAddress, name: "Recipient" } }],
    ccRecipients: [],
    receivedDateTime: "2026-08-08T10:00:00Z",
    bodyPreview: item.body.slice(0, 40),
    isRead: false,
    ...(withBody
      ? { body: { contentType: "text", content: item.body } }
      : {}),
  };
}

function outlookFetch(attacks: Attack[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/mailFolders/inbox/messages")) {
      return Response.json({
        value: attacks.map((item) => outlookMessage(item, false)),
        "@odata.count": attacks.length,
      });
    }
    if (href.includes("/messages?") && href.includes("$filter=")) {
      const filter = new URL(href).searchParams.get("$filter") ?? "";
      const id = filter.match(/conversationId eq '([^']+)'/)?.[1];
      const item = attacks.find((attackItem) => attackItem.id === id);
      if (!item) return Response.json({ value: [] });
      return Response.json({ value: [outlookMessage(item, true)] });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

const model: ReaderModel = async (input) => {
  const from =
    input.conversation.messages[input.conversation.messages.length - 1]?.from
      .email ?? "";
  const local = from.split("@")[0] ?? "";
  if (local === "alex") {
    return {
      home: "matter",
      summary: "Confirm pricing renewal",
      rationale: "The sender asked for a confirmation.",
      owner: "you",
      ask: "Confirm the pricing renewal",
      obligation: false,
      matterRef: "pricing renewal",
      yields: [],
      evidence: [],
    };
  }
  return {
    home: "matter",
    summary: "Vendor distribution notice",
    rationale: "Classified as live work.",
    owner: "team",
    ask: "nothing — informational",
    obligation: false,
    yields: [],
    evidence: [],
  };
};

type Stored = {
  id: string;
  providerId: string;
  home: string | null;
  matterId: string | null;
  vetoReasons: string[];
  linkedMatterIds: string[];
};

async function loadStored(
  pool: import("pg").Pool,
  accountId: AccountId,
): Promise<Map<string, Stored>> {
  const rows = await pool.query<{
    id: string;
    provider_conversation_id: string;
    home: string | null;
    matter_id: string | null;
    veto_reasons: string[] | null;
    linked: string[] | null;
  }>(
    `select c.id,
            c.provider_conversation_id,
            d.home,
            d.matter_id,
            d.veto_reasons,
            coalesce(
              array_agg(mc.matter_id) filter (where mc.matter_id is not null),
              '{}'
            ) as linked
       from seer.conversations c
       left join seer.conversation_decisions d
         on d.conversation_id = c.id and d.is_current
       left join seer.matter_conversations mc
         on mc.conversation_id = c.id
      where c.account_id = $1
      group by c.id, d.home, d.matter_id, d.veto_reasons`,
    [accountId],
  );
  return new Map(
    rows.rows.map((row) => [
      row.provider_conversation_id,
      {
        id: row.id,
        providerId: row.provider_conversation_id,
        home: row.home,
        matterId: row.matter_id,
        vetoReasons: row.veto_reasons ?? [],
        linkedMatterIds: row.linked ?? [],
      },
    ]),
  );
}

const db = await startTestDb();
const failures: string[] = [];
function expect(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

try {
  const userId = await upsertUser(OWN);

  async function seedMatter(accountId: AccountId): Promise<string> {
    const row = await db.pool.query<{ id: string }>(
      `insert into seer.matters (account_id, title, org_unit, title_source)
       values ($1, $2, 'acme', 'inferred')
       returning id`,
      [accountId, MATTER_TITLE],
    );
    return row.rows[0].id;
  }

  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: OWN,
  });
  const acmeMatterId = await seedMatter(gmailAccount);
  await syncAccount(
    gmailAccount,
    new GmailProvider({
      accessToken: "test-access-token",
      accountEmail: OWN,
      fetchImpl: gmailFetch(GMAIL_ATTACKS),
    }),
    "full",
  );

  const beforeRead = await loadStored(db.pool, gmailAccount);
  for (const item of [BROADCAST[0], DIRECT[0]]) {
    const stored = beforeRead.get(item.id);
    expect(stored, `synced ${item.id}`);
    if (!stored) continue;
    const suggestions = await suggestMattersForConversation(
      gmailAccount,
      asConversationId(stored.id),
    );
    const acme = suggestions.find((suggestion) => suggestion.matterId === acmeMatterId);
    expect(
      acme?.related === false,
      `suggest ${item.id} must not mark the Acme matter related (related=${String(acme?.related)})`,
    );
  }

  const placeTarget = beforeRead.get("d-send");
  expect(placeTarget, "synced d-send");
  if (placeTarget) {
    const placed = await placeConversationOnMatter(
      gmailAccount,
      asConversationId(placeTarget.id),
      {},
    );
    expect(
      placed.matterId !== acmeMatterId,
      `place d-send filed onto the existing Acme matter ${placed.matterId}`,
    );
  }

  clearContextInputCache();
  const gmailRead = await readBatch(gmailAccount, OWN, model, { limit: 50 });
  expect(
    gmailRead.failed === 0 && gmailRead.decided === GMAIL_ATTACKS.length,
    `gmail readBatch decided=${gmailRead.decided} failed=${gmailRead.failed}`,
  );

  const outlookAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: OWN,
  });
  const outlookMatterId = await seedMatter(outlookAccount);
  await syncAccount(
    outlookAccount,
    new OutlookProvider({
      accessToken: "test-access-token",
      accountEmail: OWN,
      fetchImpl: outlookFetch(OUTLOOK_ATTACKS),
    }),
    "full",
  );
  clearContextInputCache();
  const outlookRead = await readBatch(outlookAccount, OWN, model, { limit: 50 });
  expect(
    outlookRead.failed === 0 && outlookRead.decided === OUTLOOK_ATTACKS.length,
    `outlook readBatch decided=${outlookRead.decided} failed=${outlookRead.failed}`,
  );

  async function assertReads(
    label: string,
    accountId: AccountId,
    matterId: string,
    attacks: Attack[],
  ): Promise<void> {
    const stored = await loadStored(db.pool, accountId);
    for (const item of attacks) {
      const row = stored.get(item.id);
      if (!row) {
        failures.push(`${label} ${item.id} was not stored`);
        continue;
      }
      const onAcme =
        row.matterId === matterId || row.linkedMatterIds.includes(matterId);
      if (item.kind === "control") {
        expect(!onAcme, `${label} ${item.id} control joined the Acme matter`);
        expect(
          row.home === "record",
          `${label} ${item.id} control home=${row.home}`,
        );
        continue;
      }
      expect(
        !onAcme,
        `${label} ${item.id} (${item.from}) was filed onto the Acme matter`,
      );
      if (item.kind === "broadcast") {
        expect(
          row.home === "record",
          `${label} ${item.id} broadcast home=${row.home} veto=${row.vetoReasons.join(",")}`,
        );
        for (const reason of [
          "matter_untrusted_sender",
          "matter_not_direct",
          "matter_no_open_work",
        ]) {
          expect(
            row.vetoReasons.includes(reason),
            `${label} ${item.id} missing veto ${reason} (have ${row.vetoReasons.join(",") || "none"})`,
          );
        }
      }
    }
  }

  await assertReads("gmail", gmailAccount, acmeMatterId, GMAIL_ATTACKS);
  await assertReads("outlook", outlookAccount, outlookMatterId, OUTLOOK_ATTACKS);

  assert.deepEqual(failures, [], failures.join("\n"));
  console.log("v2-matter-prefix-misfile: OK");
} finally {
  await db.stop();
}
