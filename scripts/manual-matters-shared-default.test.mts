/**
 * Cross-user leak: loadMatterEdits hands every mailbox with no saved edits
 * the same module-level object, and create / rename / add / delete mutate it.
 *
 * These tests exercise that object through the legacy matters route and the
 * brief rebuild. They fail while the shared default is in place and pass
 * once every load returns its own renames map and manual array.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/manual-matters-shared-default.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";

if (typeof mock.module !== "function") {
  console.error(
    "Run with: node --experimental-test-module-mocks --import tsx scripts/manual-matters-shared-default.test.mts",
  );
  process.exit(1);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "seer-matter-edits-"));
process.env.SEER_DATA_DIR = dataDir;
for (const name of [
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
]) {
  delete process.env[name];
}

let sessionEmail: string | null = null;
mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () =>
      sessionEmail
        ? {
            email: sessionEmail,
            accessToken: "placeholder-access-token",
            provider: "google",
            name: sessionEmail,
            accountId: "acct-test",
          }
        : null,
  },
});

// buildBrief calls generateText once it has inbox rows. The leak is in the
// edit overlay after that call. `output` is GenerateTextResult.output in
// ai@7.0.31 (node_modules/ai/dist/index.d.ts). An empty matter list is the
// same shape the brief already uses when a chunk returns nothing.
const realAi = await import("ai");
let modelCalls = 0;
mock.module("ai", {
  namedExports: {
    Output: realAi.Output,
    generateText: async () => {
      modelCalls += 1;
      return { output: { summary: "", matters: [] } };
    },
  },
});

const route = await import("../src/app/api/matters/route.ts");
const matters = await import("../src/lib/inbox/matters.ts");
const manual = await import("../src/lib/store/manual-matters.ts");
const kv = await import("../src/lib/store/kv.ts");

const ALICE = "alice@rditrials.com";
const BOB = "bob@rditrials.com";
const SAM = "sam.stored@rditrials.com";
const RENEE = "renee@rditrials.com";
const CARA = "cara@rditrials.com";
const NICK = "nick@rditrials.com";
const DEE = "dee@rditrials.com";
const OTTO = "otto@rditrials.com";
const PLANNER = "planner@rditrials.com";
const MINA = "mina@rditrials.com";
const UNA = "una@rditrials.com";
const READER = "brief.reader@rditrials.com";
const MAILBOX = "brief.mail@rditrials.com";

const ALICE_TITLE = "Alice private acquisition";
const ALICE_GOAL = "Close the quiet acquisition";
const ALICE_UNIT = "alice-only-unit";
const ALICE_MESSAGE = "alice-msg-1";
const BOB_TITLE = "Bob hiring plan";
const SAM_TITLE = "Sam stored matter";
const PLANTER_TITLE = "Planner quiet filing";
const PLANTER_NEXT = "Send the quiet term sheet";
const RENEE_TITLE = "Planted budget title";
const VICTIM_TITLE = "Victim's own budget matter";
const RENAMED_ID = "read:thread-9";
const NICK_MESSAGE = "nick-added-msg";
const VICTIM_MESSAGE = "victim-msg";
const MINA_TITLE = "Mina planted title";

type Edits = {
  renames: Record<string, { title: string; at: string }>;
  manual: Array<{
    id: string;
    title: string;
    orgUnit?: string;
    goal?: string;
    nextAction?: string;
    emailIds: string[];
  }>;
};

function editsKey(email: string) {
  return `matter-edits:${email.toLowerCase()}`;
}

async function storedEdits(email: string): Promise<Edits | null> {
  return kv.kvGet<Edits>(editsKey(email));
}

async function getAs(email: string) {
  sessionEmail = email;
  const res = await route.GET();
  const body = (await res.json()) as { edits?: Edits; error?: string };
  return { status: res.status, body };
}

async function postAs(email: string | null, payload: unknown) {
  sessionEmail = email;
  const res = await route.POST(
    new Request("http://localhost/api/matters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  const body = (await res.json()) as {
    ok?: boolean;
    matterId?: string;
    error?: string;
  };
  return { status: res.status, body };
}

function titles(edits: Edits | null | undefined) {
  return (edits?.manual ?? []).map((matter) => matter.title);
}

function renameTitles(edits: Edits | null | undefined) {
  return Object.fromEntries(
    Object.entries(edits?.renames ?? {}).map(([id, rename]) => [id, rename.title]),
  );
}

const failures: string[] = [];
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

try {
  // A signed-out caller is refused before any edit document is written.
  await check("signed-out create writes nothing", async () => {
    const refused = await postAs(null, {
      action: "create",
      title: ALICE_TITLE,
      goal: ALICE_GOAL,
      emailIds: [ALICE_MESSAGE],
    });
    assert.equal(refused.status, 401);
    assert.equal(await storedEdits(ALICE), null);
  });

  // A mailbox that already has its own document is not the victim. Sam's
  // snapshot stays Sam's even after later mailboxes mutate the default.
  const samCreated = await postAs(SAM, {
    action: "create",
    title: SAM_TITLE,
    goal: "Sam's own goal",
    emailIds: ["sam-msg"],
  });
  await check("stored mailbox keeps only its own create", async () => {
    assert.equal(samCreated.status, 200);
    assert.deepEqual(titles(await storedEdits(SAM)), [SAM_TITLE]);
  });

  // Positive control: a mailbox that has its own saved edits rebuilds a
  // promoted matter under the title from its own read, with no planted rename.
  const controlMessage: EmailItem = {
    id: VICTIM_MESSAGE,
    threadId: "thread-9",
    fromEmail: "sam.chen@partner.example",
    fromName: "Sam Chen",
    subject: "Revised budget",
    snippet: "Please review the revised budget",
    receivedAt: "2026-01-02T00:00:00.000Z",
    isUnread: false,
  };
  const controlRead: Understanding = {
    id: VICTIM_MESSAGE,
    threadId: "thread-9",
    version: 1,
    readAt: "2026-01-02T00:00:00.000Z",
    kind: "study update",
    oneLine: "Budget needs a revision",
    ask: "Send the revised budget",
    owner: "you",
    entities: [],
    org: { unit: "board", confidence: 0.9 },
    importance: 2,
    disposition: "matter",
    matterTitle: VICTIM_TITLE,
  };
  const controlBrief = await matters.buildBrief(SAM, [controlMessage], null, null, {
    [VICTIM_MESSAGE]: controlRead,
  });
  await check("a saved mailbox keeps its own promoted title", () => {
    const own = controlBrief.matters.find((matter) => matter.title === VICTIM_TITLE);
    assert.ok(own, "promoted matter should keep the title from this mailbox's read");
    assert.equal(own?.emailIds.includes(VICTIM_MESSAGE), true);
    assert.equal(
      controlBrief.matters.some((matter) => matter.title === RENEE_TITLE),
      false,
    );
  });

  const probeA = await manual.loadMatterEdits("probe-a@rditrials.com");
  const probeB = await manual.loadMatterEdits("probe-b@rditrials.com");
  await check("missing documents do not share one edits object", () => {
    assert.notStrictEqual(
      probeA,
      probeB,
      "two mailboxes with no saved edits must not be handed the same edits object",
    );
    assert.notStrictEqual(
      probeA.manual,
      probeB.manual,
      "manual lists from a missing document must not be the same array",
    );
    assert.notStrictEqual(
      probeA.renames,
      probeB.renames,
      "rename maps from a missing document must not be the same object",
    );
  });

  // A later read has to miss anything a previous caller wrote onto the
  // object load returned. Sharing the array or the map fails this.
  probeA.manual.push({
    id: "probe-manual",
    title: "Probe manual",
    orgUnit: "probe-unit",
    goal: "Probe goal",
    nextAction: "Probe next",
    emailIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  probeA.renames["probe-id"] = {
    title: "Probe rename",
    at: "2026-01-01T00:00:00.000Z",
  };
  const probeC = await manual.loadMatterEdits("probe-c@rditrials.com");
  await check("a later load does not see mutations of an earlier load", () => {
    assert.deepEqual(probeC.manual, []);
    assert.deepEqual(probeC.renames, {});
  });

  const aliceCreated = await postAs(ALICE, {
    action: "create",
    title: ALICE_TITLE,
    goal: ALICE_GOAL,
    orgUnit: ALICE_UNIT,
    emailIds: [ALICE_MESSAGE],
  });
  await check("create response returns a matter id", () => {
    assert.equal(aliceCreated.status, 200, aliceCreated.body.error);
    assert.equal(typeof aliceCreated.body.matterId, "string");
  });
  const aliceMatterId = aliceCreated.body.matterId ?? "mine-alice-private-acquisition";

  const aliceSaved = await storedEdits(ALICE);
  await check("create persists only the caller's matter", () => {
    assert.deepEqual(titles(aliceSaved), [ALICE_TITLE]);
    assert.deepEqual(aliceSaved?.manual.map((matter) => matter.goal), [ALICE_GOAL]);
    assert.deepEqual(aliceSaved?.manual.map((matter) => matter.orgUnit), [ALICE_UNIT]);
    assert.deepEqual(aliceSaved?.manual.map((matter) => matter.emailIds), [
      [ALICE_MESSAGE],
    ]);
    assert.deepEqual(renameTitles(aliceSaved), {});
  });

  // Sam saved before Alice. His document must stay his.
  const samAfter = await getAs(SAM);
  await check("a mailbox that already had edits does not pick up later ones", () => {
    assert.equal(samAfter.status, 200);
    assert.deepEqual(titles(samAfter.body.edits), [SAM_TITLE]);
    assert.deepEqual(renameTitles(samAfter.body.edits), {});
  });

  // Bob has never saved edits. GET /api/matters is his own mailbox.
  const bobRead = await getAs(BOB);
  await check("GET /api/matters does not return another mailbox's edits", () => {
    assert.equal(bobRead.status, 200);
    assert.deepEqual(titles(bobRead.body.edits), []);
    assert.deepEqual(renameTitles(bobRead.body.edits), {});
    assert.equal(
      bobRead.body.edits?.manual.some((matter) =>
        matter.emailIds.includes(ALICE_MESSAGE),
      ),
      false,
    );
  });

  const bobCreated = await postAs(BOB, {
    action: "create",
    title: BOB_TITLE,
    goal: "Fill the open role",
    emailIds: ["bob-msg"],
  });
  await check("bob create is accepted", () => {
    assert.equal(bobCreated.status, 200, bobCreated.body.error);
  });
  const bobSaved = await storedEdits(BOB);
  await check("create does not write the previous mailbox into this one", () => {
    assert.deepEqual(titles(bobSaved), [BOB_TITLE]);
    assert.equal(
      bobSaved?.manual.some((matter) => matter.goal === ALICE_GOAL),
      false,
    );
    assert.equal(
      bobSaved?.manual.some((matter) => matter.emailIds.includes(ALICE_MESSAGE)),
      false,
    );
  });

  // createMatter stores nextAction on the same object the route mutates.
  // The route does not forward that field today; the store function does.
  const planted = await manual.createMatter(PLANNER, {
    title: PLANTER_TITLE,
    goal: "File the quiet plan",
    orgUnit: "planner-only-unit",
    nextAction: PLANTER_NEXT,
    emailIds: ["planner-msg"],
  });
  await check("createMatter persists only that caller's next action", async () => {
    assert.equal(planted.matter.nextAction, PLANTER_NEXT);
    assert.deepEqual(titles(await storedEdits(PLANNER)), [PLANTER_TITLE]);
    assert.deepEqual(
      (await storedEdits(PLANNER))?.manual.map((matter) => matter.nextAction),
      [PLANTER_NEXT],
    );
  });

  const renee = await postAs(RENEE, {
    action: "rename",
    matterId: RENAMED_ID,
    title: RENEE_TITLE,
  });
  await check("rename persists only the caller's rename", async () => {
    assert.equal(renee.status, 200, renee.body.error);
    assert.deepEqual(renameTitles(await storedEdits(RENEE)), {
      [RENAMED_ID]: RENEE_TITLE,
    });
    assert.deepEqual(titles(await storedEdits(RENEE)), []);
  });

  const caraRead = await getAs(CARA);
  await check("GET does not return another mailbox's rename", () => {
    assert.equal(caraRead.status, 200);
    assert.equal(caraRead.body.edits?.renames[RENAMED_ID], undefined);
    assert.deepEqual(titles(caraRead.body.edits), []);
  });
  const cara = await postAs(CARA, {
    action: "rename",
    matterId: "read:cara-thread",
    title: "Cara's own title",
  });
  await check("rename does not save the previous mailbox's matters", async () => {
    assert.equal(cara.status, 200, cara.body.error);
    assert.deepEqual(renameTitles(await storedEdits(CARA)), {
      "read:cara-thread": "Cara's own title",
    });
    assert.deepEqual(titles(await storedEdits(CARA)), []);
  });

  const nick = await postAs(NICK, {
    action: "add",
    matterId: aliceMatterId,
    emailIds: [NICK_MESSAGE],
  });
  await check("add is accepted", () => {
    assert.equal(nick.status, 200, nick.body.error);
  });
  const nickSaved = await storedEdits(NICK);
  await check("add does not attach another mailbox's matter", () => {
    assert.equal(
      nickSaved?.manual.some((matter) => matter.title === ALICE_TITLE) ?? false,
      false,
    );
    assert.equal(
      (nickSaved?.manual ?? []).some((matter) =>
        matter.emailIds.includes(NICK_MESSAGE),
      ),
      false,
    );
  });
  // Adding to a matter Nick does not have must not rewrite Alice's document.
  const aliceAfterAdd = await storedEdits(ALICE);
  await check("add does not write into the other mailbox's saved matter", () => {
    assert.equal(
      aliceAfterAdd?.manual.some((matter) =>
        matter.emailIds.includes(NICK_MESSAGE),
      ),
      false,
    );
  });

  const dee = await postAs(DEE, {
    action: "delete",
    matterId: "missing-matter",
  });
  await check("delete is accepted", () => {
    assert.equal(dee.status, 200, dee.body.error);
  });
  const deeSaved = await storedEdits(DEE);
  await check("delete does not save another mailbox's edits", () => {
    assert.deepEqual(titles(deeSaved), []);
    assert.deepEqual(renameTitles(deeSaved), {});
  });

  const otto = await getAs(OTTO);
  await check("a later empty mailbox still sees a private document", () => {
    assert.equal(otto.status, 200);
    assert.deepEqual(
      titles(otto.body.edits),
      [],
      "a mailbox with no saved edits received another mailbox's manual matters",
    );
    assert.deepEqual(
      renameTitles(otto.body.edits),
      {},
      "a mailbox with no saved edits received another mailbox's renames",
    );
  });

  const callsBeforeEmpty = modelCalls;
  const emptyBrief = await matters.buildBrief(READER, []);
  await check("empty brief keeps only this mailbox's manual matters", () => {
    assert.equal(
      modelCalls,
      callsBeforeEmpty,
      "an empty inbox rebuild must not call the model",
    );
    assert.equal(
      emptyBrief.matters.some((matter) => matter.title === ALICE_TITLE),
      false,
    );
    assert.equal(
      emptyBrief.matters.some((matter) => matter.goal === ALICE_GOAL),
      false,
    );
    assert.equal(
      emptyBrief.matters.some((matter) => matter.orgUnit === ALICE_UNIT),
      false,
    );
    assert.equal(
      emptyBrief.matters.some((matter) => matter.nextAction === PLANTER_NEXT),
      false,
    );
    assert.equal(
      emptyBrief.matters.some((matter) => matter.title === "Probe manual"),
      false,
    );
    assert.equal(
      emptyBrief.matters.some(
        (matter) =>
          matter.category === "mine" &&
          matter.narrative === "yours — nothing from the inbox in it right now" &&
          matter.title === ALICE_TITLE,
      ),
      false,
    );
  });

  const callsBeforeMail = modelCalls;
  const mailBrief = await matters.buildBrief(
    MAILBOX,
    [controlMessage],
    null,
    null,
    { [VICTIM_MESSAGE]: controlRead },
  );
  await check("brief applies only this mailbox's renames and manual matters", () => {
    assert.ok(modelCalls > callsBeforeMail, "the inbox rebuild should reach the model seam");
    assert.equal(
      mailBrief.matters.some((matter) => matter.title === RENEE_TITLE),
      false,
      "another mailbox's rename was applied to this brief",
    );
    assert.equal(
      mailBrief.matters.some((matter) => matter.title === ALICE_TITLE),
      false,
      "another mailbox's manual matter was kept in this brief",
    );
    assert.equal(
      mailBrief.matters.some(
        (matter) =>
          matter.emailIds.includes(ALICE_MESSAGE) && matter.title === ALICE_TITLE,
      ),
      false,
    );
    const own = mailBrief.matters.find((matter) => matter.title === VICTIM_TITLE);
    assert.ok(own, "the mailbox's own promoted matter must keep its title");
    assert.equal(own?.emailIds.includes(VICTIM_MESSAGE), true);
    assert.equal(
      mailBrief.matters.some(
        (matter) =>
          matter.title === ALICE_TITLE && matter.emailIds.includes(ALICE_MESSAGE),
      ),
      false,
    );
  });

  // The other rename branch: the id matches a manual matter, so the title is
  // written onto that matter instead of the renames map.
  const mina = await postAs(MINA, {
    action: "rename",
    matterId: aliceMatterId,
    title: MINA_TITLE,
  });
  await check("renaming a manual id does not save other mailboxes' matters", async () => {
    assert.equal(mina.status, 200, mina.body.error);
    assert.deepEqual(titles(await storedEdits(MINA)), []);
    assert.equal(
      (await storedEdits(MINA))?.manual.some((matter) => matter.goal === ALICE_GOAL) ??
        false,
      false,
    );
  });
  const una = await getAs(UNA);
  await check("an in-place manual rename does not reach the next mailbox", () => {
    assert.equal(una.status, 200);
    assert.equal(
      una.body.edits?.manual.some((matter) => matter.title === MINA_TITLE) ?? false,
      false,
    );
    assert.equal(
      una.body.edits?.manual.some((matter) => matter.goal === ALICE_GOAL) ?? false,
      false,
    );
  });

  if (failures.length) {
    throw new Error(`${failures.length} check(s) failed:\n${failures.join("\n")}`);
  }
  console.log("manual-matters shared-default tests passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
