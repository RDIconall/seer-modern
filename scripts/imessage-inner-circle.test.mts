/**
 * Spec for iMessage → person-graph promotion.
 *
 * These assertions describe the safe behavior. They fail while sync treats
 * every address on a BlueBubbles contact card, and every chat participant
 * that appears once, as someone the user texts.
 *
 * The signed-in mailbox is stubbed at the session boundary. Everything
 * after that — save, fetch, contact/chat parsing, person-graph writes,
 * and triage — is the product code. The stand-in server returns the
 * BlueBubbles shapes those functions already parse:
 *   GET  /api/v1/server/info  → data.computer_id, data.server_version
 *   GET  /api/v1/contact      → data[].emails[].address, phoneNumbers[].address
 *   POST /api/v1/chat/query   → data[].guid, participants[].address,
 *                               lastMessage.dateCreated, lastMessage.isFromMe
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { mock } from "node:test";
import type { AddressInfo } from "node:net";

const dataDir = mkdtempSync(`${tmpdir()}/seer-imessage-`);
process.env.SEER_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
for (const name of [
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
  delete process.env[name];
}

const PASSWORD = "placeholder-bluebubbles-password";

let sessionEmail = "mailbox@rditrials.com";

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => ({
      accessToken: "placeholder-access-token",
      provider: "google" as const,
      email: sessionEmail,
      name: "Mailbox",
      accountId: "00000000-0000-4000-8000-000000000001",
    }),
  },
});

const { POST } = await import("../src/app/api/imessage/route.ts");
const { loadPeople, savePeople } = await import("../src/lib/store/people.ts");
const { loadTextingStats } = await import("../src/lib/imessage/bluebubbles.ts");
const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const {
  classifyInboxWithAssistant,
  PROMPT_VERSION,
} = await import("../src/lib/inbox/gemini-triage.ts");
const { saveDecisions } = await import("../src/lib/store/decision-cache.ts");

type BbState = {
  computerId: string;
  contacts: unknown[];
  chats: unknown[];
  /** When set, contact and chat requests are redirected here. */
  redirectOrigin: string | null;
  hits: { info: number; contact: number; chat: number };
};

function listen(
  state: BbState,
): Promise<{ origin: string; state: BbState; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/v1/server/info") {
      state.hits.info += 1;
      const body = JSON.stringify({
        status: 200,
        message: "Success",
        data: {
          computer_id: state.computerId,
          os_version: "test",
          server_version: "1.9.9",
          private_api: false,
          proxy_service: "none",
          helper_connected: false,
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (path === "/api/v1/contact" || path === "/api/v1/chat/query") {
      if (path === "/api/v1/contact") state.hits.contact += 1;
      else state.hits.chat += 1;
      if (state.redirectOrigin) {
        res.writeHead(307, {
          location: `${state.redirectOrigin}${url.pathname}${url.search}`,
        });
        res.end();
        return;
      }
      const data = path === "/api/v1/contact" ? state.contacts : state.chats;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 200, message: "Success", data }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 404, message: "Not Found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function chat(
  guid: string,
  address: string,
  sent: boolean | null,
  when: number,
) {
  return {
    guid,
    participants: [{ address }],
    lastMessage:
      sent === null
        ? { dateCreated: when }
        : { dateCreated: when, isFromMe: sent, text: "hello" },
  };
}

const sentAt = 1_700_000_000_000;

const contacts = [
  {
    firstName: "Alex",
    lastName: "Friend",
    displayName: "Alex Friend",
    phoneNumbers: [{ address: "+1 (818) 555-0100", id: "p1" }],
    emails: [
      { address: "Alex.Friend@Example.com", id: "e1" },
      { address: "phish-card@evil.example", id: "e2" },
      { address: "  Other.Phish@Evil.example ", id: "e3" },
    ],
  },
  {
    firstName: "Mom",
    lastName: "Family",
    displayName: "Mom Family",
    phoneNumbers: [{ address: "8185550199", id: "p2" }],
    emails: [
      { address: "mom@family.example", id: "e4" },
      { address: "phish-mom@evil.example", id: "e5" },
    ],
  },
];

const chats = [
  chat("chat-alex-1", "Alex.Friend@Example.com", true, sentAt),
  chat("chat-alex-2", "alex.friend@example.com", true, sentAt + 60_000),
  chat("chat-once", "once@evil.example", true, sentAt + 120_000),
  chat("chat-in-1", "inbound@evil.example", false, sentAt + 180_000),
  chat("chat-in-2", "inbound@evil.example", false, sentAt + 240_000),
  chat("chat-nosend-1", "nosend@evil.example", null, sentAt + 300_000),
  chat("chat-nosend-2", "nosend@evil.example", null, sentAt + 360_000),
  chat("chat-dup", "dup@evil.example", true, sentAt + 420_000),
  chat("chat-dup", "dup@evil.example", true, sentAt + 480_000),
  chat("chat-phone-1", "+1 (818) 555-0199", true, sentAt + 540_000),
  chat("chat-phone-2", "8185550199", true, sentAt + 600_000),
  chat("chat-self-1", "mailbox@rditrials.com", true, sentAt + 660_000),
  chat("chat-self-2", "mailbox@rditrials.com", true, sentAt + 720_000),
  chat("chat-pinned-1", "pinned@evil.example", true, sentAt + 780_000),
  chat("chat-pinned-2", "pinned@evil.example", true, sentAt + 840_000),
];

const PROMO = {
  subject: "50% off sale exclusive offer",
  snippet: "Shop the new arrivals today",
};

const history = {
  accountEmail: "mailbox@rditrials.com",
  builtAt: "2026-01-01T00:00:00.000Z",
  contacts: {},
  engagedCount: 0,
  contactCount: 0,
  repliedThreads: {},
};

async function post(body: unknown) {
  const res = await POST(
    new Request("http://127.0.0.1/api/imessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, text, json: text ? safeJson(text) : null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redact(value: string) {
  return value.replace(/password=[^&\s"]+/gi, "password=<redacted>");
}

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failures += 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  FAIL ${name}\n       ${redact(msg)}`);
    });
}

const verified = await listen({
  computerId: "mac-verified",
  contacts,
  chats,
  redirectOrigin: null,
  hits: { info: 0, contact: 0, chat: 0 },
});

try {
  sessionEmail = "mailbox@rditrials.com";
  await savePeople(sessionEmail, {
    "pinned@evil.example": {
      email: "pinned@evil.example",
      tier: "machine",
      by: "user",
      reason: "The user set this by hand",
      judgedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  const saved = await post({
    action: "save",
    url: verified.origin,
    password: PASSWORD,
  });
  assert.equal(saved.status, 200, redact(saved.text));

  const synced = await post({ action: "sync" });
  assert.equal(synced.status, 200, redact(synced.text));
  const body = synced.json as { promotedToInner?: number };

  const people = await loadPeople(sessionEmail);
  const stats = await loadTextingStats(sessionEmail);

  await check("only a handle the user sent in more than one chat is texting evidence", () => {
    assert.equal(body.promotedToInner, 1, JSON.stringify(body));
    assert.deepEqual(Object.keys(stats?.people ?? {}).sort(), ["alex.friend@example.com"]);
    const alex = people["alex.friend@example.com"];
    assert.equal(alex?.tier, "inner");
    assert.equal(alex?.by, "evidence");
    assert.match(alex?.reason ?? "", /iMessage/);
    assert.match(alex?.reason ?? "", /Alex Friend/);
    assert.ok((stats?.people["alex.friend@example.com"]?.chats ?? 0) >= 2);
  });

  const blocked = [
    "phish-card@evil.example",
    "other.phish@evil.example",
    "once@evil.example",
    "inbound@evil.example",
    "nosend@evil.example",
    "dup@evil.example",
    "mom@family.example",
    "phish-mom@evil.example",
    "mailbox@rditrials.com",
  ];
  await check("contact-card emails and unsent or one-off handles stay out of the graph", () => {
    for (const email of blocked) {
      assert.equal(people[email], undefined, `${email} was stored on the person graph`);
      assert.equal(
        stats?.people[email],
        undefined,
        `${email} was counted as someone the user texts`,
      );
    }
  });

  await check("a hand-set person is not overwritten by sync", () => {
    const pinned = people["pinned@evil.example"];
    assert.equal(pinned?.by, "user");
    assert.equal(pinned?.tier, "machine");
    assert.equal(pinned?.reason, "The user set this by hand");
  });

  await saveDecisions(
    sessionEmail,
    new Map([
      [
        "cached-phish",
        {
          action: "delete_now",
          confidence: "HIGH",
          reason: "Promotional mail",
          instruction: "Delete",
          source: "gemini",
          ruleId: "gemini:test",
          ts: Date.now(),
          v: PROMPT_VERSION,
        },
      ],
      [
        "cached-alex",
        {
          action: "delete_now",
          confidence: "HIGH",
          reason: "Promotional mail",
          instruction: "Delete",
          source: "gemini",
          ruleId: "gemini:test",
          ts: Date.now(),
          v: PROMPT_VERSION,
        },
      ],
    ]),
  );

  const receivedAt = new Date().toISOString();
  const graded = await classifyInboxWithAssistant(
    sessionEmail,
    [
      { id: "rules-phish", fromEmail: "phish-card@evil.example", fromName: "Alex Friend", ...PROMO, receivedAt },
      { id: "rules-once", fromEmail: "once@evil.example", fromName: "Once", ...PROMO, receivedAt },
      { id: "rules-mom", fromEmail: "mom@family.example", fromName: "Mom Family", ...PROMO, receivedAt },
      { id: "rules-stranger", fromEmail: "stranger@unknown.example", fromName: "Stranger", ...PROMO, receivedAt },
      { id: "rules-alex", fromEmail: "alex.friend@example.com", fromName: "Alex Friend", ...PROMO, receivedAt },
      { id: "cached-phish", fromEmail: "phish-card@evil.example", fromName: "Alex Friend", ...PROMO, receivedAt },
      { id: "cached-alex", fromEmail: "alex.friend@example.com", fromName: "Alex Friend", ...PROMO, receivedAt },
      { id: "learned-once", fromEmail: "once@evil.example", fromName: "Once", ...PROMO, receivedAt },
    ],
    history,
    () => null,
    classifyMessage,
    {
      geminiEnabled: false,
      actionMemory: {
        "once@evil.example": { archive: 0, trash: 4, lastAt: receivedAt },
      },
    },
  );

  await check("a stranger's promo is still a delete, so the rewrite is the tier", () => {
    const stranger = graded.get("rules-stranger");
    assert.equal(stranger?.action, "delete_now");
    assert.match(stranger?.debug.ruleId ?? "", /marketing/);
  });

  await check("rules fallback does not surface injected senders as respond", () => {
    for (const id of ["rules-phish", "rules-once", "rules-mom"]) {
      const row = graded.get(id);
      assert.equal(row?.action, "delete_now", `${id} ${row?.debug.ruleId}`);
      assert.notEqual(row?.debug.ruleId, "person-floor", id);
    }
  });

  await check("a cached delete of an injected sender is not rewritten to keep", () => {
    const cached = graded.get("cached-phish");
    assert.equal(cached?.action, "delete_now");
    assert.equal(cached?.debug.ruleId, "gemini:test");
  });

  await check("a learned delete of an injected sender is not rewritten to keep", () => {
    const learned = graded.get("learned-once");
    assert.equal(learned?.action, "delete_now");
    assert.equal(learned?.debug.ruleId, "learned-trash");
  });

  await check("a handle the user actually texts is still protected", () => {
    const rules = graded.get("rules-alex");
    assert.equal(rules?.action, "respond");
    assert.equal(rules?.debug.ruleId, "person-floor");
    const cached = graded.get("cached-alex");
    assert.equal(cached?.action, "read_and_archive");
    assert.equal(cached?.debug.ruleId, "person-protect");
  });
} finally {
  await verified.close();
}

const qualified = (address: string, prefix: string) => ({
  contacts: [
    {
      displayName: "Named",
      phoneNumbers: [],
      emails: [{ address }],
    },
  ],
  chats: [
    chat(`${prefix}-1`, address, true, sentAt),
    chat(`${prefix}-2`, address, true, sentAt + 1_000),
  ],
});

const swappedState: BbState = {
  computerId: "mac-verified",
  ...qualified("swapped@evil.example", "swap"),
  redirectOrigin: null,
  hits: { info: 0, contact: 0, chat: 0 },
};
const swapped = await listen(swappedState);
try {
  sessionEmail = "identity@rditrials.com";
  await savePeople(sessionEmail, {
    "kept@example.com": {
      email: "kept@example.com",
      tier: "known",
      by: "user",
      reason: "Kept",
      judgedAt: "2020-01-01T00:00:00.000Z",
    },
  });
  const saved = await post({
    action: "save",
    url: swapped.origin,
    password: PASSWORD,
  });
  assert.equal(saved.status, 200, redact(saved.text));
  swappedState.computerId = "mac-replaced";
  const before = await loadPeople(sessionEmail);
  const synced = await post({ action: "sync" });
  await check("a different computer_id than the one saved is not applied", async () => {
    assert.notEqual(synced.status, 200, redact(synced.text));
    assert.equal(await loadTextingStats(sessionEmail), null);
    const people = await loadPeople(sessionEmail);
    assert.deepEqual(people, before);
    assert.equal(people["swapped@evil.example"], undefined);
    assert.equal(people["kept@example.com"]?.by, "user");
  });
} finally {
  await swapped.close();
}

const attackerState: BbState = {
  computerId: "mac-attacker",
  ...qualified("redirect@evil.example", "redir"),
  redirectOrigin: null,
  hits: { info: 0, contact: 0, chat: 0 },
};
const attacker = await listen(attackerState);
const verifiedRedirectState: BbState = {
  computerId: "mac-verified",
  contacts: [],
  chats: [],
  redirectOrigin: attacker.origin,
  hits: { info: 0, contact: 0, chat: 0 },
};
const verifiedRedirect = await listen(verifiedRedirectState);
try {
  sessionEmail = "redirect@rditrials.com";
  await savePeople(sessionEmail, {
    "kept@example.com": {
      email: "kept@example.com",
      tier: "known",
      by: "user",
      reason: "Kept",
      judgedAt: "2020-01-01T00:00:00.000Z",
    },
  });
  const saved = await post({
    action: "save",
    url: verifiedRedirect.origin,
    password: PASSWORD,
  });
  assert.equal(saved.status, 200, redact(saved.text));
  const before = await loadPeople(sessionEmail);
  const synced = await post({ action: "sync" });
  await check("contact and chat bodies from another origin are not applied", async () => {
    assert.ok(attackerState.hits.contact + attackerState.hits.chat > 0, "redirect was not followed");
    assert.notEqual(synced.status, 200, redact(synced.text));
    assert.equal(await loadTextingStats(sessionEmail), null);
    const people = await loadPeople(sessionEmail);
    assert.deepEqual(people, before);
    assert.equal(people["redirect@evil.example"], undefined);
  });
} finally {
  await verifiedRedirect.close();
  await attacker.close();
}

if (failures > 0) {
  console.error(`imessage-inner-circle: ${failures} failed`);
  process.exitCode = 1;
} else {
  console.log("imessage-inner-circle: OK");
}
