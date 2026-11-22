/**
 * Inbound volume must not become a relationship.
 *
 * These tests exercise the grader the Today, mailbox, all-tasks, brief,
 * catch-up, message, and sync routes run: inbox rows become mail history,
 * history feeds the people tier, and that tier is applied to later grades.
 *
 * They describe the safe behavior. They fail while three delivered messages
 * from a personal-looking address are enough to save a "known" person and
 * to rewrite delete, unsubscribe, and promo grades to archive.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MailMessageListItem } from "../src/lib/mail/types.ts";
import type { ActionMemory } from "../src/lib/store/action-memory.ts";
import type { PersonalContext } from "../src/lib/inbox/personal-context.ts";
import type { SeerLabelStore } from "../src/lib/mail/seer-labels.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "seer-sender-trust-"));
process.env.SEER_DATA_DIR = dataDir;
for (const key of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
]) {
  delete process.env[key];
}

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant, PROMPT_VERSION } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { getOrBuildMailHistory } = await import(
  "../src/lib/inbox/mail-history-store.ts"
);
const { buildMailHistory, historySignals } = await import(
  "../src/lib/inbox/mail-history.ts"
);
const { getInboxSnapshot } = await import("../src/lib/mail/inbox-snapshot.ts");
const { makeGmailLabelStore } = await import("../src/lib/mail/seer-labels.ts");
const { knownSenders } = await import("../src/lib/brain/relationships.ts");
const { saveDecisions } = await import("../src/lib/store/decision-cache.ts");
const { kvDelete, kvSet } = await import("../src/lib/store/kv.ts");
const { loadPeople, tierFromEvidence } = await import(
  "../src/lib/store/people.ts"
);

const ATTACKER = "jordan.hale@gmail.com";
const MACHINE = "noreply@shop.example";
const FRIEND = "casey.nguyen@gmail.com";
const CLEARING = new Set([
  "delete_now",
  "read_and_delete",
  "unsubscribe",
  "glance_promo",
]);
const LIFE_TIERS = new Set(["inner", "known", "new-credible"]);

let failures = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e instanceof Error ? e.message : e}`);
  }
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/** Shape produced by Gmail hydrateOne / Graph mapListItem for one delivered row. */
function mail(input: {
  id: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  toEmail?: string;
  labelIds?: string[];
  isUnread?: boolean;
}): MailMessageListItem {
  return {
    id: input.id,
    threadId: `thread-${input.id}`,
    fromEmail: input.fromEmail,
    fromName: input.fromEmail.split("@")[0] ?? input.fromEmail,
    peerEmail: input.toEmail,
    subject: input.subject,
    snippet: input.snippet,
    receivedAt: input.receivedAt,
    isUnread: input.isUnread ?? true,
    labelIds: input.labelIds,
  };
}

function sentTo(owner: string, id: string, peer: string): MailMessageListItem {
  return mail({
    id,
    fromEmail: owner,
    toEmail: peer,
    subject: "Re: hello",
    snippet: "Thanks, talk soon.",
    receivedAt: hoursAgo(5),
    isUnread: false,
  });
}

const PROMO = {
  subject: "Exclusive offer",
  snippet: "50% off flash deal and free shipping.",
};
const UNSUB = {
  subject: "Exclusive offer",
  snippet: "50% off flash deal and free shipping. Unsubscribe from this list.",
};
const BLAND = {
  subject: "Shoe catalog",
  snippet: "Here is another copy of the shoe catalog.",
};
const URGENCY = {
  subject: "Last chance",
  snippet: "50% off flash deal and free shipping.",
};

type GradeOpts = {
  account: string;
  inbox: MailMessageListItem[];
  sent?: MailMessageListItem[];
  archived?: MailMessageListItem[];
  override?: (email: string) => "delete_now" | null;
  actionMemory?: ActionMemory;
  personal?: PersonalContext;
  labels?: SeerLabelStore | null;
};

async function grade(opts: GradeOpts) {
  const inbox = await getInboxSnapshot(
    opts.account,
    async () => opts.inbox,
    { force: true },
  );
  const history = await getOrBuildMailHistory(
    opts.account,
    "unused-access-token",
    {
      listFolder: async (_token, folder) => {
        if (folder === "sent") return opts.sent ?? [];
        if (folder === "inbox") return inbox;
        return [];
      },
      listArchive: async () => opts.archived ?? [],
    },
    inbox,
  );
  const decisions = await classifyInboxWithAssistant(
    opts.account,
    inbox.map((m) => ({
      id: m.id,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      subject: m.subject,
      snippet: m.snippet,
      labelIds: m.labelIds,
      threadId: m.threadId,
      receivedAt: m.receivedAt,
    })),
    history,
    (email) => opts.override?.(email) ?? null,
    classifyMessage,
    {
      personal: opts.personal,
      actionMemory: opts.actionMemory,
      labels: opts.labels,
      geminiEnabled: false,
    },
  );
  return { inbox, history, decisions };
}

function describe(decisions: Awaited<ReturnType<typeof grade>>["decisions"], id: string) {
  const row = decisions.get(id);
  if (!row) return `${id}: missing`;
  return `${id}: ${row.action} [${row.debug.ruleId}] source=${row.source}`;
}

function assertClearing(
  decisions: Awaited<ReturnType<typeof grade>>["decisions"],
  id: string,
) {
  const row = decisions.get(id);
  assert.ok(row, describe(decisions, id));
  assert.ok(
    CLEARING.has(row.action),
    `volume must not keep this mail; ${describe(decisions, id)}`,
  );
  assert.notEqual(row.debug.ruleId, "person-protect");
  assert.notEqual(row.debug.ruleId, "vip-protect");
}

async function forgetHistory(account: string) {
  const key = account.toLowerCase().trim();
  await kvDelete(`mail-history:${key}`);
  await kvDelete(`inbox-snap:${key}`);
}

console.log("sender trust volume");

const volumeAccount = "owner@mailbox.test";
const volumeInbox = [
  mail({ id: "in-1", fromEmail: ATTACKER, ...BLAND, receivedAt: hoursAgo(3), toEmail: volumeAccount }),
  mail({ id: "in-2", fromEmail: ATTACKER, ...BLAND, receivedAt: hoursAgo(2), toEmail: volumeAccount }),
  mail({ id: "in-3", fromEmail: ATTACKER, ...BLAND, receivedAt: hoursAgo(1), toEmail: volumeAccount }),
  mail({ id: "promo", fromEmail: ATTACKER, ...PROMO, receivedAt: hoursAgo(0.5), toEmail: volumeAccount }),
  mail({ id: "unsub", fromEmail: ATTACKER, ...UNSUB, receivedAt: hoursAgo(0.4), toEmail: volumeAccount }),
  mail({ id: "urgent", fromEmail: ATTACKER, ...URGENCY, receivedAt: hoursAgo(0.3), toEmail: volumeAccount }),
];

await check(
  "history does not call a sender known from inbound volume alone",
  () => {
    const history = buildMailHistory(volumeAccount, volumeInbox, [], []);
    const signals = historySignals(history, ATTACKER);
    assert.ok(signals.receivedFrom >= 3);
    assert.equal(signals.sentTo, 0);
    assert.equal(signals.keptFrom, 0);
    assert.notEqual(signals.relationship, "known");
    assert.notEqual(signals.relationship, "engaged");
  },
);

await check(
  "local evidence does not mint a known tier from inbound volume alone",
  () => {
    const history = buildMailHistory(volumeAccount, volumeInbox, [], []);
    const signals = historySignals(history, ATTACKER);
    const evidence = tierFromEvidence({
      fromEmail: ATTACKER,
      sentTo: signals.sentTo,
      receivedFrom: signals.receivedFrom,
      inContacts: false,
      hasMeeting: false,
    });
    assert.equal(evidence, null);
  },
);

let volumeGrade: Awaited<ReturnType<typeof grade>> | undefined;

await check(
  "the inbox grade does not keep or protect mail just because it arrived three times",
  async () => {
    volumeGrade = await grade({ account: volumeAccount, inbox: volumeInbox });
    assert.equal(
      volumeGrade.history.contacts[ATTACKER]?.receivedFrom,
      volumeInbox.length,
    );
    const misses: string[] = [];
    for (const id of ["in-1", "in-2", "in-3", "promo", "unsub"]) {
      const row = volumeGrade.decisions.get(id);
      if (!row || !CLEARING.has(row.action) || row.debug.ruleId === "person-protect") {
        misses.push(describe(volumeGrade.decisions, id));
      }
    }
    assert.deepEqual(misses, []);
  },
);

await check(
  "urgency bait from a volume-only sender stays delete, not act-today",
  async () => {
    const account = "owner-urgent@mailbox.test";
    const graded = await grade({
      account,
      inbox: [
        ...[1, 2, 3].map((n) =>
          mail({
            id: `bait-setup-${n}`,
            fromEmail: ATTACKER,
            ...BLAND,
            receivedAt: hoursAgo(n + 1),
            toEmail: account,
          }),
        ),
        mail({
          id: "bait",
          fromEmail: ATTACKER,
          ...URGENCY,
          receivedAt: hoursAgo(0.2),
          toEmail: account,
        }),
      ],
    });
    const row = graded.decisions.get("bait");
    assert.equal(
      row?.action,
      "delete_now",
      `urgency bait from a stranger must stay junk; ${describe(graded.decisions, "bait")}`,
    );
    assert.notEqual(row?.debug.ruleId, "trusted-urgency");
    assert.notEqual(row?.debug.ruleId, "person-protect");
  },
);

await check(
  "the grader does not store that sender as a person in the user's life",
  async () => {
    const people = await loadPeople(volumeAccount);
    const record = people[ATTACKER];
    const known = knownSenders({
      people,
      history: volumeGrade?.history,
      personal: { builtAt: "", contacts: [], events: [] },
    });
    assert.equal(
      known.has(ATTACKER),
      false,
      `relationship floor includes ${ATTACKER} from stored tier ${record?.tier ?? "none"} (${record?.reason ?? ""})`,
    );
    assert.ok(
      !record || !LIFE_TIERS.has(record.tier),
      `stored ${record?.tier} by ${record?.by}: ${record?.reason ?? ""}`,
    );
    assert.notEqual(record?.vip, true);
  },
);

async function gradeOne(
  id: string,
  fields: { subject: string; snippet: string },
  extra?: { labelIds?: string[]; labels?: SeerLabelStore | null },
) {
  await forgetHistory(volumeAccount);
  const graded = await grade({
    account: volumeAccount,
    labels: extra?.labels,
    inbox: [
      mail({
        id,
        fromEmail: ATTACKER,
        subject: fields.subject,
        snippet: fields.snippet,
        receivedAt: hoursAgo(0.2),
        toEmail: volumeAccount,
        labelIds: extra?.labelIds,
      }),
    ],
  });
  assert.ok(
    (graded.history.contacts[ATTACKER]?.receivedFrom ?? 0) < 3,
    `later history still shows ${graded.history.contacts[ATTACKER]?.receivedFrom} inbound`,
  );
  return graded;
}

await check(
  "later promo is still deleted when only one message remains in the inbox",
  async () => {
    const graded = await gradeOne("later-promo", PROMO);
    assert.equal(
      graded.decisions.get("later-promo")?.action,
      "delete_now",
      describe(graded.decisions, "later-promo"),
    );
    assert.notEqual(
      graded.decisions.get("later-promo")?.debug.ruleId,
      "person-protect",
    );
  },
);

await check(
  "later unsubscribe is not rewritten after the earlier mail is gone",
  async () => {
    const graded = await gradeOne("later-unsub", UNSUB);
    assert.equal(
      graded.decisions.get("later-unsub")?.action,
      "unsubscribe",
      describe(graded.decisions, "later-unsub"),
    );
    assert.notEqual(
      graded.decisions.get("later-unsub")?.debug.ruleId,
      "person-protect",
    );
  },
);

await check(
  "a stored promo grade is not rewritten to archive for a volume-only sender",
  async () => {
    const glanceId = "later-glance";
    await saveDecisions(
      volumeAccount,
      new Map([
        [
          glanceId,
          {
            action: "glance_promo",
            confidence: "HIGH",
            reason: "Stored promo grade",
            source: "gemini",
            ruleId: "gemini:stored-promo",
            ts: Date.now(),
            v: PROMPT_VERSION,
          },
        ],
      ]),
    );
    const graded = await gradeOne(glanceId, PROMO);
    assert.equal(
      graded.decisions.get(glanceId)?.action,
      "glance_promo",
      describe(graded.decisions, glanceId),
    );
    assert.notEqual(
      graded.decisions.get(glanceId)?.debug.ruleId,
      "person-protect",
    );
  },
);

await check(
  "a saved unsubscribe label is not rewritten to archive for a volume-only sender",
  async () => {
    await kvSet(`gmail-labels:${volumeAccount}`, {
      builtAt: new Date().toISOString(),
      map: { unsubscribe: "Label_unsub" },
    });
    await kvSet(`labels-era:${volumeAccount}`, PROMPT_VERSION);
    const labels = await makeGmailLabelStore(
      "unused-access-token",
      volumeAccount,
    );
    assert.ok(labels, "label map seeded in the local store should load");
    const graded = await gradeOne("later-label", UNSUB, {
      labels,
      labelIds: ["Label_unsub"],
    });
    assertClearing(graded.decisions, "later-label");
  },
);

await check(
  "a learned trash prior is not undone by inbound volume",
  async () => {
    const account = "owner-learned@mailbox.test";
    const memory: ActionMemory = {
      [ATTACKER]: { archive: 0, trash: 4, lastAt: hoursAgo(1) },
    };
    const graded = await grade({
      account,
      actionMemory: memory,
      inbox: [1, 2, 3, 4].map((n) =>
        mail({
          id: `learned-${n}`,
          fromEmail: ATTACKER,
          ...(n === 4 ? PROMO : BLAND),
          receivedAt: hoursAgo(n),
          toEmail: account,
        }),
      ),
    });
    const row = graded.decisions.get("learned-4");
    assert.equal(row?.action, "delete_now", describe(graded.decisions, "learned-4"));
    assert.match(row?.debug.ruleId ?? "", /learned-trash/);
    const people = await loadPeople(account);
    assert.ok(!people[ATTACKER] || !LIFE_TIERS.has(people[ATTACKER].tier));
  },
);

await check(
  "two inbound messages stay a stranger and marketing still unsubscribes",
  async () => {
    const account = "owner-few@mailbox.test";
    const graded = await grade({
      account,
      inbox: [1, 2].map((n) =>
        mail({
          id: `few-${n}`,
          fromEmail: ATTACKER,
          ...UNSUB,
          receivedAt: hoursAgo(n),
          toEmail: account,
        }),
      ),
    });
    const row = graded.decisions.get("few-1");
    assert.equal(row?.action, "unsubscribe", describe(graded.decisions, "few-1"));
    const people = await loadPeople(account);
    assert.equal(people[ATTACKER], undefined);
  },
);

await check(
  "an automated address is not saved as a person because it wrote three times",
  async () => {
    const account = "owner-machine@mailbox.test";
    const graded = await grade({
      account,
      inbox: [1, 2, 3].map((n) =>
        mail({
          id: `machine-${n}`,
          fromEmail: MACHINE,
          ...PROMO,
          receivedAt: hoursAgo(n),
          toEmail: account,
        }),
      ),
    });
    const people = await loadPeople(account);
    const record = people[MACHINE];
    assert.ok(!record || !LIFE_TIERS.has(record.tier));
    assert.equal(graded.history.contacts[MACHINE]?.receivedFrom, 3);
    assert.notEqual(historySignals(graded.history, MACHINE).relationship, "known");
  },
);

await check(
  "a taught delete still deletes after three inbound messages",
  async () => {
    const account = "owner-override@mailbox.test";
    const graded = await grade({
      account,
      override: (email) => (email.toLowerCase() === ATTACKER ? "delete_now" : null),
      inbox: [1, 2, 3].map((n) =>
        mail({
          id: `override-${n}`,
          fromEmail: ATTACKER,
          ...PROMO,
          receivedAt: hoursAgo(n),
          toEmail: account,
        }),
      ),
    });
    const row = graded.decisions.get("override-1");
    assert.equal(row?.action, "delete_now", describe(graded.decisions, "override-1"));
    assert.equal(row?.source, "override");
  },
);

await check(
  "mail the user actually sent still protects that person from a delete grade",
  async () => {
    const account = "owner-inner@mailbox.test";
    const messageId = "from-friend";
    await saveDecisions(
      account,
      new Map([
        [
          messageId,
          {
            action: "delete_now",
            confidence: "HIGH",
            reason: "Stored delete grade",
            source: "gemini",
            ruleId: "gemini:stored-delete",
            ts: Date.now(),
            v: PROMPT_VERSION,
          },
        ],
      ]),
    );
    const graded = await grade({
      account,
      sent: [sentTo(account, "sent-friend", FRIEND)],
      inbox: [
        mail({
          id: messageId,
          fromEmail: FRIEND,
          ...PROMO,
          receivedAt: hoursAgo(0.2),
          toEmail: account,
        }),
      ],
    });
    assert.ok((graded.history.contacts[FRIEND]?.sentTo ?? 0) > 0);
    const row = graded.decisions.get(messageId);
    assert.equal(row?.action, "read_and_archive", describe(graded.decisions, messageId));
    assert.equal(row?.debug.ruleId, "person-protect");
  },
);

await check(
  "a saved contact is still protected from auto-delete",
  async () => {
    const account = "owner-contact@mailbox.test";
    const contact = "sam.rivera@gmail.com";
    const personal: PersonalContext = {
      builtAt: new Date().toISOString(),
      contacts: [contact],
      events: [],
    };
    const graded = await grade({
      account,
      personal,
      inbox: [
        mail({
          id: "contact-1",
          fromEmail: contact,
          ...UNSUB,
          receivedAt: hoursAgo(0.2),
          toEmail: account,
        }),
      ],
    });
    const row = graded.decisions.get("contact-1");
    assert.ok(row, "contact message graded");
    assert.equal(CLEARING.has(row.action), false, describe(graded.decisions, "contact-1"));
  },
);

await check(
  "mail the user read and kept is still a relationship",
  () => {
    const history = buildMailHistory(
      "owner-kept@mailbox.test",
      [],
      [],
      [
        {
          fromEmail: ATTACKER,
          isUnread: false,
          receivedAt: hoursAgo(10),
        },
        {
          fromEmail: ATTACKER,
          isUnread: false,
          receivedAt: hoursAgo(9),
        },
      ],
    );
    assert.equal(historySignals(history, ATTACKER).relationship, "known");
    const swept = buildMailHistory(
      "owner-kept@mailbox.test",
      [],
      [],
      [
        { fromEmail: ATTACKER, isUnread: true, receivedAt: hoursAgo(8) },
        { fromEmail: ATTACKER, isUnread: true, receivedAt: hoursAgo(7) },
      ],
    );
    assert.notEqual(historySignals(swept, ATTACKER).relationship, "known");
  },
);

await rm(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
