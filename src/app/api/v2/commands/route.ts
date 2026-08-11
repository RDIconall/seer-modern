import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { executeCommand } from "@/lib/v2/commands/execute";
import { buildInboxView } from "@/lib/v2/view/build";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import type { Command } from "@/lib/v2/commands/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The one write endpoint for the v2 client. Every mutation is a command with an
 * idempotency key. Mail mutations enqueue optimistically; the response returns
 * fresh triage and mailbox projections so the client never re-derives state.
 */
export async function POST(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  let body: { command?: Command; idempotencyKey?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.command || !body.idempotencyKey) {
    return NextResponse.json(
      { error: "command and idempotencyKey are required" },
      { status: 400 },
    );
  }

  const provider = await providerFor(account);
  const result = await executeCommand(
    { accountId: account.id, provider },
    body.command,
    body.idempotencyKey,
  );
  const view = await buildInboxView(account.id, account.provider);
  const mailbox = await getMailboxView(
    account.id,
    "inbox",
    parseMailboxLimit(null),
  );
  return NextResponse.json({ result, view, mailbox });
}
