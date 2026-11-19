/**
 * Write-side of the shared sender-override crash.
 *
 * A signed-in mailbox POSTs /api/reclassify. The handler must reject an
 * action that is not one of the nine triage actions and must not persist
 * it. A teaching that is accepted must apply only to the mailbox that
 * sent it. These assertions fail while any truthy action is stored in the
 * single deployment-wide sender-overrides document.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/sender-override-poison.test.mts
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-override-write-"));
process.env.SEER_DATA_DIR = dataDir;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;

const ATTACKER = "attacker@rditrials.com";
const VICTIM = "victim@rditrials.com";
const POISON_SENDER = "digest@newsletters.example";
const POISON_ACTION = "not_a_triage_action";
const TAUGHT_SENDER = "notices@vendor.example";
const TAUGHT_ACTION = "glance_promo";
const TRIAGE_ACTIONS = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
] as const;

const session: { email: string | null } = { email: ATTACKER };

mock.module("@/auth", {
  namedExports: {
    auth: async () =>
      session.email
        ? { user: { email: session.email }, provider: "google" }
        : null,
  },
});

// No active-account cookie. requireMailSession then resolves the signed-in
// mailbox by email. next/headers cookies() cannot run without a request
// store; the jar below is the empty jar that lookup sees in that case.
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get(_name: string) {
        return undefined;
      },
    }),
  },
});

const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const db = await startTestDb();

const attackerId = await accounts.upsertUser(ATTACKER);
const victimId = await accounts.upsertUser(VICTIM);
await accounts.upsertAccountWithCredentials({
  userId: attackerId,
  provider: "google",
  email: ATTACKER,
  displayName: "Attacker",
  accessToken: "placeholder-access-token",
  expiresAt: Date.now() + 3_600_000,
});
await accounts.upsertAccountWithCredentials({
  userId: victimId,
  provider: "google",
  email: VICTIM,
  displayName: "Victim",
  accessToken: "placeholder-access-token",
  expiresAt: Date.now() + 3_600_000,
});

const route = await import("../src/app/api/reclassify/route.ts");
const senders = await import("../src/lib/store/senders.ts");
const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);

async function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/reclassify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function persistedText(): Promise<string> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const chunks: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    chunks.push(await readFile(path.join(dataDir, name), "utf8"));
  }
  return chunks.join("\n");
}

async function classifiedSource(
  accountEmail: string,
  fromEmail: string,
): Promise<{ action: string; source?: string }> {
  const decisions = await classifyInboxWithAssistant(
    accountEmail,
    [
      {
        id: `msg-${accountEmail}-${fromEmail}`,
        threadId: `thread-${fromEmail}`,
        fromEmail,
        fromName: "Vendor",
        subject: "Weekly notes",
        snippet: "Here is the digest.",
        receivedAt: "2026-11-01T15:00:00.000Z",
      },
    ],
    null,
    (email) => senders.getSenderOverride(email),
    classifyMessage,
    { geminiEnabled: false },
  );
  const result = decisions.get(`msg-${accountEmail}-${fromEmail}`);
  if (!result) {
    throw new Error(`${accountEmail} got no verdict for ${fromEmail}`);
  }
  return { action: result.action, source: result.source };
}

const failures: string[] = [];
function expect(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}

try {
  session.email = null;
  const signedOut = await post({
    fromEmail: POISON_SENDER,
    action: POISON_ACTION,
  });
  expect(signedOut.status === 401, `signed-out status ${signedOut.status}`);
  expect((await persistedText()) === "", "signed-out request wrote a document");

  session.email = ATTACKER;
  const poisoned = await post({
    fromEmail: "Digest@Newsletters.example",
    action: POISON_ACTION,
  });
  expect(
    poisoned.status === 400,
    `unknown action was accepted (status ${poisoned.status})`,
  );
  const weird = await post({
    fromEmail: "other@newsletters.example",
    action: { not_an_action_object: true },
  });
  expect(weird.status === 400, `action object was accepted (status ${weird.status})`);
  const blank = await post({
    fromEmail: "blank@newsletters.example",
    action: "   ",
  });
  expect(blank.status === 400, `blank action was accepted (status ${blank.status})`);

  const disk = await persistedText();
  expect(
    !disk.includes(POISON_ACTION),
    "rejected action was written to the override document",
  );
  expect(
    !disk.includes("not_an_action_object"),
    "rejected action object was written to the override document",
  );
  const listed = await senders.listSenderOverrides();
  expect(
    !listed.some((row) => row.email === POISON_SENDER),
    "rejected sender remained in the override map",
  );

  session.email = VICTIM;
  try {
    const victimAfterPoison = await classifiedSource(VICTIM, POISON_SENDER);
    expect(
      victimAfterPoison.source !== "override",
      "victim applied the poisoned sender as an override",
    );
    expect(
      victimAfterPoison.action !== POISON_ACTION,
      `victim classification action was ${victimAfterPoison.action}`,
    );
  } catch (error) {
    failures.push(
      `victim inbox classification threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  session.email = ATTACKER;
  for (const action of TRIAGE_ACTIONS) {
    const accepted = await post({
      fromEmail: `${action}@taught.example`,
      action,
    });
    expect(accepted.status === 200, `triage action ${action} status ${accepted.status}`);
  }

  const taught = await post({
    fromEmail: TAUGHT_SENDER,
    action: TAUGHT_ACTION,
  });
  expect(taught.status === 200, `taught action status ${taught.status}`);
  try {
    const asAttacker = await classifiedSource(ATTACKER, TAUGHT_SENDER);
    expect(
      asAttacker.source === "override" && asAttacker.action === TAUGHT_ACTION,
      `attacker teaching came back as ${asAttacker.source}/${asAttacker.action}`,
    );
  } catch (error) {
    failures.push(
      `attacker classification of a real teaching threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  session.email = VICTIM;
  try {
    const asVictim = await classifiedSource(VICTIM, TAUGHT_SENDER);
    expect(
      asVictim.source !== "override" && asVictim.action !== TAUGHT_ACTION,
      `victim mailbox applied an override taught by another mailbox (${asVictim.source}/${asVictim.action})`,
    );
  } catch (error) {
    failures.push(
      `victim classification of another mailbox's teaching threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const victimList = await senders.listSenderOverrides();
  expect(
    !victimList.some((row) => row.email === TAUGHT_SENDER),
    "victim could read another mailbox's sender override",
  );

  session.email = ATTACKER;
  const attackerList = await senders.listSenderOverrides();
  expect(
    attackerList.some(
      (row) => row.email === TAUGHT_SENDER && row.action === TAUGHT_ACTION,
    ),
    "the mailbox that taught the sender could not read it back",
  );

  if (failures.length > 0) {
    throw new Error(failures.map((line) => `- ${line}`).join("\n"));
  }
  console.log("sender-override-poison: ok");
} finally {
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
}
