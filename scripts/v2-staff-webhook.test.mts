import assert from "node:assert/strict";
import {
  signStaffWebhook,
  staffWebhookConfig,
  verifyStaffWebhook,
  notifyStaffWebhook,
} from "../src/lib/v2/staff/webhook.ts";

const secret = "test-secret-value";
const timestamp = "1710000000";
const body = '{"event":"bot_message.created"}';
const signature = signStaffWebhook(secret, timestamp, body);
assert.match(signature, /^sha256=[0-9a-f]{64}$/);
assert.equal(
  verifyStaffWebhook({
    secret,
    timestamp,
    rawBody: body,
    signature,
    nowSeconds: 1710000000,
  }),
  true,
);
assert.equal(
  verifyStaffWebhook({
    secret,
    timestamp,
    rawBody: body,
    signature: "sha256=deadbeef",
    nowSeconds: 1710000000,
  }),
  false,
);
assert.equal(
  verifyStaffWebhook({
    secret,
    timestamp,
    rawBody: body,
    signature,
    nowSeconds: 1710000000 + 400,
  }),
  false,
  "stale timestamp is rejected",
);

assert.equal(staffWebhookConfig({}), null);
assert.deepEqual(
  staffWebhookConfig({
    SEER_BOT_WEBHOOK_URL: "https://bot.example/hook",
    SEER_BOT_WEBHOOK_SECRET: "abc",
  }),
  { url: "https://bot.example/hook", secret: "abc" },
);

const calls: { url: string; init: RequestInit }[] = [];
await notifyStaffWebhook(
  {
    event: "bot_task.created",
    accountId: "acct",
    occurredAt: "2026-10-16T00:00:00.000Z",
    taskId: "t1",
  },
  {
    SEER_BOT_WEBHOOK_URL: "https://bot.example/hook",
    SEER_BOT_WEBHOOK_SECRET: secret,
  } as NodeJS.ProcessEnv,
  (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch,
);
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "https://bot.example/hook");
const headers = calls[0].init.headers as Record<string, string>;
assert.equal(headers["content-type"], "application/json");
assert.ok(
  verifyStaffWebhook({
    secret,
    timestamp: headers["x-seer-timestamp"],
    rawBody: String(calls[0].init.body),
    signature: headers["x-seer-signature"],
  }),
);

await notifyStaffWebhook(
  {
    event: "bot_task.updated",
    accountId: "acct",
    occurredAt: "2026-10-16T00:00:00.000Z",
  },
  {} as NodeJS.ProcessEnv,
  (async () => {
    throw new Error("should not post when unset");
  }) as typeof fetch,
);

console.log("v2-staff-webhook: OK");
