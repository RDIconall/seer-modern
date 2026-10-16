import { createHmac, timingSafeEqual } from "node:crypto";

export type StaffWebhookEvent =
  | "bot_task.created"
  | "bot_task.updated"
  | "bot_task.commented"
  | "bot_message.created"
  | "triage_proposal.decided";

export type StaffWebhookPayload = {
  event: StaffWebhookEvent;
  accountId: string;
  accountEmail?: string | null;
  occurredAt: string;
  taskId?: string | null;
  messageId?: string | null;
  proposalId?: string | null;
  task?: Record<string, unknown> | null;
  message?: Record<string, unknown> | null;
  proposal?: Record<string, unknown> | null;
};

export function staffWebhookConfig(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  secret: string;
} | null {
  const url = env.SEER_BOT_WEBHOOK_URL?.trim();
  const secret = env.SEER_BOT_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}

export function signStaffWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `sha256=${mac}`;
}

export function verifyStaffWebhook(input: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signature: string | null | undefined;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): boolean {
  if (!input.signature) return false;
  const expected = signStaffWebhook(input.secret, input.timestamp, input.rawBody);
  const got = input.signature.trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSeconds ?? 300;
  return Math.abs(now - ts) <= skew;
}

export async function notifyStaffWebhook(
  payload: StaffWebhookPayload,
  env: NodeJS.ProcessEnv = process.env,
  post: typeof fetch = fetch,
): Promise<void> {
  const config = staffWebhookConfig(env);
  if (!config) return;
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signStaffWebhook(config.secret, timestamp, rawBody);
  try {
    await post(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seer-timestamp": timestamp,
        "x-seer-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (cause) {
    console.error(
      "[seer] staff webhook failed",
      payload.event,
      cause instanceof Error ? cause.message : cause,
    );
  }
}
