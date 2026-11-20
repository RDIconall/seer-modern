/**
 * Charge history must not cross sender addresses.
 *
 * These tests fail while triage keys merchant amounts by registrable
 * domain (and records a charge from a subject keyword alone). They pass
 * once each address keeps its own receipt history, that history is the
 * only baseline sent to the model, and the saved grade plus Gmail label
 * are computed from it.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/merchant-charge-isolation.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "seer-merchants-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.AI_GATEWAY_API_KEY = "placeholder";
for (const name of [
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
]) {
  delete process.env[name];
}

type PromptItem = {
  id: string;
  email?: string;
  usual?: string;
  amount?: number;
  subject?: string;
};

const prompts: string[] = [];
let modelCategory = "Receipts";

mock.module("ai", {
  namedExports: {
    async generateText(args: { prompt?: string }) {
      const prompt = String(args?.prompt ?? "");
      prompts.push(prompt);
      const payload = JSON.parse(prompt) as { id: string }[];
      return {
        output: {
          items: payload.map((item) => ({
            id: item.id,
            action: "read_and_archive",
            confidence: 0.91,
            reason: "Model filed the message",
            instruction: "File it",
            task: "none",
            category: modelCategory,
            sender: "machine" as const,
            credible: false,
            importance: 1,
            deed: "none",
          })),
        },
      };
    },
    Output: {
      object(spec: unknown) {
        return spec;
      },
    },
  },
});

type FetchCall = { url: string; method: string; body: string | null };
const fetchCalls: FetchCall[] = [];

function installGmailFetch() {
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body == null ? null : String(init.body);
    fetchCalls.push({ url, method, body });
    if (method === "GET" && url.endsWith("/users/me/labels")) {
      return Response.json({ labels: [] });
    }
    if (method === "POST" && url.endsWith("/users/me/labels")) {
      const name = JSON.parse(body ?? "{}").name as string;
      return Response.json({ id: `label:${name}` });
    }
    if (method === "POST" && url.endsWith("/messages/batchModify")) {
      return Response.json({});
    }
    return new Response("unexpected gmail call", { status: 500 });
  }) as typeof fetch;
}

function batchModifies(calls: FetchCall[]): { ids: string[]; addLabelIds: string[] }[] {
  return calls
    .filter((call) => call.url.endsWith("/messages/batchModify"))
    .map((call) => {
      const body = JSON.parse(call.body ?? "{}") as {
        ids?: string[];
        addLabelIds?: string[];
      };
      return { ids: body.ids ?? [], addLabelIds: body.addLabelIds ?? [] };
    });
}

type MailItem = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  threadId: string;
};

let seq = 0;
function charge(fromEmail: string, dollars: number): MailItem {
  seq += 1;
  return {
    id: `msg-${seq}`,
    fromEmail,
    fromName: fromEmail.split("@")[0] ?? fromEmail,
    subject: `Payment receipt $${dollars}`,
    snippet: "Filed copy of the charge.",
    receivedAt: new Date().toISOString(),
    threadId: `thread-${seq}`,
  };
}

async function main() {
  const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
  const {
    PROMPT_VERSION,
    classifyInboxWithAssistant,
  } = await import("../src/lib/inbox/gemini-triage.ts");
  const { loadDecisions } = await import("../src/lib/store/decision-cache.ts");
  const { loadMerchants } = await import("../src/lib/store/merchants.ts");
  const { makeGmailLabelStore } = await import("../src/lib/mail/seer-labels.ts");

  async function grade(accountEmail: string, items: MailItem[], defer: boolean) {
    installGmailFetch();
    const before = prompts.length;
    const labels = await makeGmailLabelStore("placeholder", accountEmail);
    if (!labels) throw new Error("Gmail label store was not created");
    let deferred: (() => Promise<void>) | undefined;
    const results = await classifyInboxWithAssistant(
      accountEmail,
      items,
      {
        accountEmail,
        builtAt: new Date().toISOString(),
        contacts: {},
        engagedCount: 0,
        contactCount: 0,
        repliedThreads: {},
      },
      async () => null,
      classifyMessage,
      {
        labels,
        geminiEnabled: true,
        deferAi: defer,
        onDeferred: defer
          ? (run) => {
              deferred = run;
            }
          : undefined,
      },
    );
    if (defer) {
      if (!deferred) throw new Error("deferred grader was not scheduled");
      await deferred();
    }
    const saved = await loadDecisions(
      accountEmail,
      items.map((item) => item.id),
      PROMPT_VERSION,
    );
    const promptItems = prompts
      .slice(before)
      .flatMap((prompt) => JSON.parse(prompt) as PromptItem[]);
    return {
      results,
      saved,
      promptItems,
      batches: batchModifies(fetchCalls),
    };
  }

  async function seed(
    accountEmail: string,
    fromEmail: string,
    dollars: number,
    count: number,
    defer: boolean,
  ) {
    const items = Array.from({ length: count }, () => charge(fromEmail, dollars));
    await grade(accountEmail, items, defer);
  }

  const failures: string[] = [];
  async function check(name: string, run: () => Promise<void>) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }

  for (const domain of ["gmail.com", "outlook.com", "yahoo.com"]) {
    await check(`inline price jump stays on ${domain} history`, async () => {
      const account = `owner-jump-${domain}`;
      const landlord = `landlord@${domain}`;
      const attacker = `attacker@${domain}`;
      modelCategory = "Receipts";
      await seed(account, landlord, 100, 3, false);
      await seed(account, attacker, 10000, 3, false);
      const bill = charge(landlord, 400);
      const graded = await grade(account, [bill], false);
      const row = graded.promptItems.find((item) => item.id === bill.id);
      const action = graded.saved.get(bill.id)?.action;
      const db = await loadMerchants(account);
      assert.equal(
        action,
        "review_subscription",
        `${landlord} graded ${action}; model baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}; keys ${Object.keys(db).join(",")}`,
      );
      assert.equal(row?.usual, "usually ~$100 (3 charges)");
      assert.deepEqual(graded.results.get(bill.id)?.action, "review_subscription");
      assert.deepEqual(graded.batches, [
        { ids: [bill.id], addLabelIds: ["label:Seer/review_subscription"] },
      ]);
      assert.deepEqual(db[landlord]?.amounts, [100, 100, 100, 400]);
      assert.deepEqual(db[attacker]?.amounts, [10000, 10000, 10000]);
      assert.equal(db[domain], undefined);
    });

    await check(`inline ordinary charge is not unusual on ${domain}`, async () => {
      const account = `owner-ordinary-${domain}`;
      const attacker = `attacker@${domain}`;
      const neighbor = `neighbor@${domain}`;
      modelCategory = "Receipts";
      await seed(account, attacker, 1, 3, false);
      const bill = charge(neighbor, 120);
      const graded = await grade(account, [bill], false);
      const row = graded.promptItems.find((item) => item.id === bill.id);
      const action = graded.saved.get(bill.id)?.action;
      const db = await loadMerchants(account);
      assert.equal(
        action,
        "read_and_archive",
        `${neighbor} graded ${action}; model baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}; keys ${Object.keys(db).join(",")}`,
      );
      assert.equal(row?.usual, undefined);
      assert.deepEqual(graded.results.get(bill.id)?.action, "read_and_archive");
      assert.deepEqual(graded.batches, [
        { ids: [bill.id], addLabelIds: ["label:Seer/read_and_archive"] },
      ]);
      assert.deepEqual(db[attacker]?.amounts, [1, 1, 1]);
      assert.deepEqual(db[neighbor]?.amounts, [120]);
      assert.equal(db[domain], undefined);
    });
  }

  await check("deferred today/mailbox path isolates gmail.com", async () => {
    const account = "owner-deferred@example.test";
    const landlord = "landlord@gmail.com";
    const attacker = "attacker@gmail.com";
    modelCategory = "Receipts";
    await seed(account, landlord, 100, 3, true);
    await seed(account, attacker, 10000, 3, true);
    const bill = charge(landlord, 400);
    const graded = await grade(account, [bill], true);
    const row = graded.promptItems.find((item) => item.id === bill.id);
    const action = graded.saved.get(bill.id)?.action;
    const db = await loadMerchants(account);
    assert.equal(
      action,
      "review_subscription",
      `deferred grade ${action}; baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}; keys ${Object.keys(db).join(",")}`,
    );
    assert.equal(row?.usual, "usually ~$100 (3 charges)");
    assert.deepEqual(graded.batches, [
      { ids: [bill.id], addLabelIds: ["label:Seer/review_subscription"] },
    ]);
    assert.notEqual(graded.results.get(bill.id)?.action, "review_subscription");
    assert.equal(graded.results.get(bill.id)?.pending, true);
    assert.deepEqual(db[landlord]?.amounts, [100, 100, 100, 400]);
    assert.deepEqual(db[attacker]?.amounts, [10000, 10000, 10000]);
  });

  await check("deferred ordinary gmail charge is not forced to review", async () => {
    const account = "owner-deferred-ordinary@example.test";
    const attacker = "attacker@gmail.com";
    const neighbor = "neighbor@gmail.com";
    modelCategory = "Receipts";
    await seed(account, attacker, 1, 3, true);
    const bill = charge(neighbor, 120);
    const graded = await grade(account, [bill], true);
    const row = graded.promptItems.find((item) => item.id === bill.id);
    const action = graded.saved.get(bill.id)?.action;
    assert.equal(
      action,
      "read_and_archive",
      `deferred grade ${action}; baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}`,
    );
    assert.equal(row?.usual, undefined);
    assert.deepEqual(graded.batches, [
      { ids: [bill.id], addLabelIds: ["label:Seer/read_and_archive"] },
    ]);
  });

  await check("consumer subdomain does not collapse onto the provider domain", async () => {
    const account = "owner-subdomain@example.test";
    const attacker = "sneak@mail.gmail.com";
    const neighbor = "neighbor@gmail.com";
    modelCategory = "Receipts";
    await seed(account, attacker, 1, 3, false);
    const bill = charge(neighbor, 120);
    const graded = await grade(account, [bill], false);
    const row = graded.promptItems.find((item) => item.id === bill.id);
    const action = graded.saved.get(bill.id)?.action;
    const db = await loadMerchants(account);
    assert.equal(
      action,
      "read_and_archive",
      `collapsed grade ${action}; baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}; keys ${Object.keys(db).join(",")}`,
    );
    assert.equal(row?.usual, undefined);
    assert.deepEqual(graded.batches, [
      { ids: [bill.id], addLabelIds: ["label:Seer/read_and_archive"] },
    ]);
    assert.deepEqual(db[attacker]?.amounts, [1, 1, 1]);
    assert.deepEqual(db[neighbor]?.amounts, [120]);
    assert.equal(db["gmail.com"], undefined);
  });

  await check("subject keyword alone does not create a charge baseline", async () => {
    const account = "owner-subject@example.test";
    const payer = "payer@gmail.com";
    modelCategory = "Notes";
    await seed(account, payer, 1, 3, false);
    modelCategory = "Receipts";
    const bill = charge(payer, 120);
    const graded = await grade(account, [bill], false);
    const row = graded.promptItems.find((item) => item.id === bill.id);
    const action = graded.saved.get(bill.id)?.action;
    const db = await loadMerchants(account);
    const amounts = db[payer]?.amounts ?? db["gmail.com"]?.amounts;
    assert.equal(
      action,
      "read_and_archive",
      `keyword-only grade ${action}; baseline ${row?.usual}; gmail ${JSON.stringify(graded.batches)}; amounts ${amounts?.join(",")}`,
    );
    assert.equal(row?.usual, undefined);
    assert.deepEqual(graded.batches, [
      { ids: [bill.id], addLabelIds: ["label:Seer/read_and_archive"] },
    ]);
    assert.deepEqual(db[payer]?.amounts, [120]);
    assert.equal(db["gmail.com"], undefined);
  });

  if (failures.length > 0) {
    console.error(`${failures.length} test(s) failed: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("all merchant charge isolation tests passed");
}

await main();
