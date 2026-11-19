/**
 * Gate: a person who can email a connected mailbox must not be able to push
 * that message's full text into the paid chief-of-staff read.
 *
 * The scheduled read (readBatch → defaultReaderModel → the gateway) has to
 * keep each message body within MESSAGE_BODY_CHAR_BUDGET characters and each
 * submitted prompt's message bodies within THREAD_BODY_CHAR_BUDGET. A thread
 * that still does not fit is refused or split so no single gateway request
 * carries more than that. When the fast call fails, the strong retry must
 * not resubmit the unbounded text. With SEER_DAILY_SPEND_LIMIT_USD unset,
 * the daily dollar ceiling is DEFAULT_DAILY_SPEND_LIMIT_USD.
 *
 * These assertions fail while the read submits the stored body unchanged.
 */
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import { defaultReaderModel } from "../src/lib/v2/intelligence/model.ts";
import {
  recordModelUsage,
  withinDailyBudget,
  withinDailySpendLimit,
} from "../src/lib/v2/intelligence/model-usage.ts";

/** Same per-message ceiling the legacy reader already applies before a model call. */
const MESSAGE_BODY_CHAR_BUDGET = 8_000;
/** Four full message budgets. A larger thread is refused or split across calls. */
const THREAD_BODY_CHAR_BUDGET = 32_000;
/** Applied when SEER_DAILY_SPEND_LIMIT_USD is unset or blank. */
const DEFAULT_DAILY_SPEND_LIMIT_USD = 5;
const TAIL_MARKER = "UNBOUNDEDMAILBODYTAIL";

const MODEL_JSON = JSON.stringify({
  home: "delete",
  summary: "No action.",
  rationale: "Informational.",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  dueDate: null,
  matterRef: null,
  yields: [],
  evidence: [],
});

type Captured = { url: string; body: string; modelId: string };

const captured: Captured[] = [];
let failFastModel = false;
const previousFetch = globalThis.fetch;
const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;
const previousSpendCap = process.env.SEER_DAILY_SPEND_LIMIT_USD;

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found?.[1] ?? "";
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? "";
}

function installGatewayFetch(): void {
  process.env.AI_GATEWAY_API_KEY = "placeholder";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("ai-gateway.vercel.sh")) {
      return previousFetch(input, init);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const modelId = headerValue(init?.headers, "ai-language-model-id");
    captured.push({ url, body, modelId });
    if (failFastModel && modelId.includes("flash")) {
      return new Response(JSON.stringify({ error: "overloaded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: MODEL_JSON }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        providerMetadata: { gateway: { generationId: "gen_test", cost: "0.01" } },
        warnings: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function restoreEnv(): void {
  globalThis.fetch = previousFetch;
  if (previousGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
  if (previousSpendCap === undefined) delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  else process.env.SEER_DAILY_SPEND_LIMIT_USD = previousSpendCap;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function oversizedText(): string {
  // The marker sits past the per-message budget, then more text follows so a
  // suffix-only trim still drops it.
  return `${"Please review the terms. "}${"x".repeat(MESSAGE_BODY_CHAR_BUDGET)}${TAIL_MARKER}${"y".repeat(20_000)}`;
}

function conversationPrompts(raw: string): { bodies: string[] }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const texts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
    for (const value of Object.values(record)) walk(value);
  };
  walk(parsed);
  const prompts: { bodies: string[] }[] = [];
  for (const text of texts) {
    if (!text.includes("\"messages\"")) continue;
    try {
      const payload = JSON.parse(text) as {
        conversation?: { messages?: { body?: unknown }[] };
      };
      const messages = payload.conversation?.messages;
      if (!Array.isArray(messages)) continue;
      prompts.push({
        bodies: messages.map((message) =>
          typeof message.body === "string" ? message.body : "",
        ),
      });
    } catch {
      // Not the chief-of-staff payload.
    }
  }
  return prompts;
}

function assertSubmittedReadsBounded(marker?: string): void {
  const reads = captured.filter((call) => call.url.includes("/language-model"));
  if (marker) {
    const offenders = reads
      .filter((call) => call.body.includes(marker))
      .map((call) => call.modelId || "request");
    assert.deepEqual(
      offenders,
      [],
      `gateway calls included text past the ${MESSAGE_BODY_CHAR_BUDGET}-character message budget: ${offenders.join(", ")}`,
    );
  }
  for (const call of reads) {
    for (const prompt of conversationPrompts(call.body)) {
      let sum = 0;
      for (const body of prompt.bodies) {
        assert.ok(
          body.length <= MESSAGE_BODY_CHAR_BUDGET,
          `message body sent to ${call.modelId || "the gateway"} is ${body.length} characters`,
        );
        sum += body.length;
      }
      assert.ok(
        sum <= THREAD_BODY_CHAR_BUDGET,
        `one ${call.modelId || "gateway"} prompt carried ${sum} characters of message body`,
      );
    }
  }
}

async function storedPlain(database: TestDb, accountId: AccountId): Promise<string> {
  const rows = await database.pool.query<{ body_text: string | null; body_html: string | null }>(
    `select body_text, body_html from seer.messages where account_id = $1 order by sent_at asc`,
    [accountId],
  );
  return rows.rows.map((row) => row.body_text ?? "").join("\n");
}

async function readSynced(accountId: AccountId, email: string): Promise<void> {
  captured.length = 0;
  await readBatch(accountId, email, defaultReaderModel, {
    limit: 10,
    concurrency: 1,
  });
}

async function assertAttackerTextWasIngested(stored: string, original: string): Promise<void> {
  assert.ok(stored.length > 0, "sync stored no plain text for the attacker message");
  assert.equal(
    original.startsWith(stored.slice(0, Math.min(stored.length, 80))),
    true,
    "stored text is not the message the provider returned",
  );
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

const database = await startTestDb();
try {
  installGatewayFetch();

  // Dollar ceiling when the operator has not opted into a number.
  await check("default dollar ceiling", async () => {
    delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
    const userId = await upsertUser("spend-default@example.com");
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email: "spend-default@example.com",
    });
    assert.equal(
      await withinDailySpendLimit(accountId),
      true,
      "a mailbox with no spend stays inside the default dollar ceiling",
    );
    await recordModelUsage({
      accountId,
      tier: "fast",
      model: "google/gemini-3.1-flash-lite",
      escalationReasons: [],
      latencyMs: 10,
      costUsd: DEFAULT_DAILY_SPEND_LIMIT_USD - 0.01,
    });
    assert.equal(
      await withinDailySpendLimit(accountId),
      true,
      "spend under the default ceiling is still allowed",
    );
    await recordModelUsage({
      accountId,
      tier: "fast",
      model: "google/gemini-3.1-flash-lite",
      escalationReasons: [],
      latencyMs: 10,
      costUsd: 0.01,
    });
    assert.equal(
      await withinDailySpendLimit(accountId),
      false,
      "unset SEER_DAILY_SPEND_LIMIT_USD still stops once the default dollar ceiling is reached",
    );
    assert.equal(
      await withinDailyBudget(accountId, "fast"),
      false,
      "the read budget includes the default dollar ceiling",
    );
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "";
    assert.equal(
      await withinDailySpendLimit(accountId),
      false,
      "a blank SEER_DAILY_SPEND_LIMIT_USD does not turn the dollar ceiling off",
    );
    delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  });

  // Short mail still reaches the gateway, so a later refusal is about size.
  await check("short message still submitted", async () => {
    const userId = await upsertUser("short-read@example.com");
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email: "short-read@example.com",
    });
    const text = "Status update with no action required.";
    const provider = new GmailProvider({
      accessToken: "placeholder",
      accountEmail: "short-read@example.com",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(
            JSON.stringify({ threads: [{ id: "short" }], resultSizeEstimate: 1 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "short",
            messages: [
              {
                id: "short-m1",
                threadId: "short",
                snippet: "Status",
                labelIds: ["INBOX"],
                internalDate: "1600000100000",
                payload: {
                  headers: [
                    { name: "From", value: "news@vendor.example" },
                    { name: "To", value: "short-read@example.com" },
                    { name: "Subject", value: "Status" },
                  ],
                  mimeType: "text/plain",
                  body: { data: b64url(text) },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await syncAccount(accountId, provider, "full");
    failFastModel = false;
    await readSynced(accountId, "short-read@example.com");
    const prompts = captured.flatMap((call) => conversationPrompts(call.body));
    assert.ok(
      prompts.some((prompt) => prompt.bodies.some((body) => body.includes(text))),
      "a normal short message must still be submitted to the gateway",
    );
  });

  async function gmailCase(
    email: string,
    threadId: string,
    plain: string | null,
    html: string | null,
  ): Promise<void> {
    const userId = await upsertUser(email);
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email,
    });
    const parts = [];
    if (plain !== null) {
      parts.push({ mimeType: "text/plain", body: { data: b64url(plain) } });
    }
    if (html !== null) {
      parts.push({ mimeType: "text/html", body: { data: b64url(html) } });
    }
    const provider = new GmailProvider({
      accessToken: "placeholder",
      accountEmail: email,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(
            JSON.stringify({ threads: [{ id: threadId }], resultSizeEstimate: 1 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: threadId,
            messages: [
              {
                id: `${threadId}-m1`,
                threadId,
                snippet: "snippet",
                labelIds: ["INBOX", "UNREAD"],
                internalDate: "1600000200000",
                payload: {
                  headers: [
                    { name: "From", value: "attacker@outside.example" },
                    { name: "To", value: email },
                    { name: "Subject", value: "Large document" },
                  ],
                  mimeType: "multipart/alternative",
                  parts,
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await syncAccount(accountId, provider, "full");
    const stored = await storedPlain(database, accountId);
    await assertAttackerTextWasIngested(stored, plain ?? html!.replace(/<[^>]+>/g, ""));
    await readSynced(accountId, email);
  }

  // Plain text as large as a provider will hand back, and the fast call fails
  // so the strong model is the retry path.
  await check("gmail plain text is bounded, including the strong retry", async () => {
    const text = oversizedText();
    failFastModel = true;
    try {
      await gmailCase("plain-oversize@example.com", "plain", text, `<p>${text}</p>`);
      assertSubmittedReadsBounded(TAIL_MARKER);
    } finally {
      failFastModel = false;
    }
  });

  // HTML-only Gmail message. The text the model reads is derived from HTML.
  await check("gmail html body is bounded", async () => {
    const text = oversizedText();
    await gmailCase(
      "html-oversize@example.com",
      "html",
      null,
      `<div>${text}</div>`,
    );
    assertSubmittedReadsBounded(TAIL_MARKER);
  });

  async function outlookCase(email: string, contentType: "text" | "html", content: string): Promise<void> {
    const userId = await upsertUser(email);
    const accountId = await upsertAccount({
      userId,
      provider: "microsoft",
      email,
    });
    const provider = new OutlookProvider({
      accessToken: "placeholder",
      accountEmail: email,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/mailFolders/inbox/messages")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "o1",
                  conversationId: "conv-oversize",
                  subject: "Large document",
                  from: { emailAddress: { address: "attacker@outside.example" } },
                  toRecipients: [{ emailAddress: { address: email } }],
                  receivedDateTime: "2026-08-01T00:00:00Z",
                  bodyPreview: "snippet",
                  isRead: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("conversationId")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "o1",
                  conversationId: "conv-oversize",
                  subject: "Large document",
                  from: { emailAddress: { address: "attacker@outside.example" } },
                  toRecipients: [{ emailAddress: { address: email } }],
                  receivedDateTime: "2026-08-01T00:00:00Z",
                  bodyPreview: "snippet",
                  body: { contentType, content },
                  isRead: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ totalItemCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await syncAccount(accountId, provider, "full");
    const stored = await storedPlain(database, accountId);
    const original = contentType === "html" ? content.replace(/<[^>]+>/g, "") : content;
    await assertAttackerTextWasIngested(stored, original);
    await readSynced(accountId, email);
  }

  await check("outlook plain text is bounded", async () => {
    const text = oversizedText();
    await outlookCase("outlook-plain@example.com", "text", text);
    assertSubmittedReadsBounded(TAIL_MARKER);
  });

  await check("outlook html body is bounded", async () => {
    const text = oversizedText();
    await outlookCase("outlook-html@example.com", "html", `<p>${text}</p>`);
    assertSubmittedReadsBounded(TAIL_MARKER);
  });

  // Eight messages that each sit on the per-message budget still exceed one prompt.
  await check("long thread is refused or split", async () => {
    const email = "thread-oversize@example.com";
    const userId = await upsertUser(email);
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email,
    });
    const bodies = Array.from({ length: 8 }, (_, index) => {
      const head = `Thread part ${index} terms `;
      return (head + "z".repeat(MESSAGE_BODY_CHAR_BUDGET)).slice(0, MESSAGE_BODY_CHAR_BUDGET);
    });
    const provider = new GmailProvider({
      accessToken: "placeholder",
      accountEmail: email,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/threads?")) {
          return new Response(
            JSON.stringify({ threads: [{ id: "thread" }], resultSizeEstimate: 1 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "thread",
            messages: bodies.map((body, index) => ({
              id: `thread-m${index}`,
              threadId: "thread",
              snippet: "part",
              labelIds: ["INBOX"],
              internalDate: String(1_600_000_300_000 + index * 1000),
              payload: {
                headers: [
                  { name: "From", value: "attacker@outside.example" },
                  { name: "To", value: email },
                  { name: "Subject", value: "Long thread" },
                ],
                mimeType: "text/plain",
                body: { data: b64url(body) },
              },
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await syncAccount(accountId, provider, "full");
    const stored = await storedPlain(database, accountId);
    assert.ok(
      stored.length > THREAD_BODY_CHAR_BUDGET,
      "sync did not keep the long thread the provider returned",
    );
    await readSynced(accountId, email);
    const prompts = captured.flatMap((call) => conversationPrompts(call.body));
    assert.ok(
      captured.length === 0 || prompts.length > 0,
      "the long thread was submitted in a shape the budget check could not see",
    );
    assertSubmittedReadsBounded();
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length} oversized-read check(s) failed:\n${failures.join("\n")}`);
  }
  console.log("v2-oversized-read: OK");
} finally {
  restoreEnv();
  await database.stop();
}
