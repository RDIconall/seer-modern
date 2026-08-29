import { after, NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { executeCommand } from "@/lib/v2/commands/execute";
import { buildInboxView } from "@/lib/v2/view/build";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import { originAllowed } from "@/lib/security/origin";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import { drainOutbox } from "@/lib/v3/outbox/drain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

function needsProvider(command: Command): boolean {
  return command.type === "send" || command.type === "reply" || command.type === "forward";
}

/**
 * The one write endpoint for the v2 client. Every mutation is a command with an
 * idempotency key. Mail mutations enqueue optimistically; the response returns
 * fresh triage and mailbox projections so the client never re-derives state.
 */
export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  let body: { command?: Command; idempotencyKey?: string; withView?: boolean };
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

  let provider;
  if (needsProvider(body.command)) {
    try {
      provider = await providerFor(account);
    } catch (cause) {
      return NextResponse.json(
        {
          result: {
            ok: false,
            replayed: false,
            error: cause instanceof Error ? cause.message : "provider unavailable",
          },
        },
        { status: 503 },
      );
    }
  }
  // Every command answers with a result. A throw used to be left to the
  // framework, which replies 500 with no body at all: the client's
  // `response.json()` then failed on the empty body and the user was told
  // "Failed to execute 'json' on 'Response'" instead of what went wrong.
  let result: CommandResult;
  try {
    result = await executeCommand(
      { accountId: account.id, provider },
      body.command,
      body.idempotencyKey,
    );
  } catch (cause) {
    console.error("v2 command failed", body.command.type, cause);
    return NextResponse.json(
      {
        result: {
          ok: false,
          replayed: false,
          error: cause instanceof Error ? cause.message : "command failed",
        },
      },
      { status: 500 },
    );
  }
  // Do not make a swipe wait for the five-minute worker. The optimistic patch
  // is already durable, so provider delivery belongs after the response; the
  // status endpoint lets the client report confirmation, retry, or failure.
  if (result.outboxId) {
    after(async () => {
      try {
        const provider = await providerFor(account);
        await drainOutbox(account.id, provider);
      } catch {
        // The row remains pending. The normal worker will retry it and the
        // status toast continues to say queued rather than inventing failure.
      }
    });
  }

  // The projections are only for the whiteboard, which patches itself from the
  // response. Building both on every command charged a bulk action two full
  // rebuilds of the inbox per row — fifty deletes meant a hundred projections
  // nobody read, and the batch crawled while they were built.
  if (!body.withView) return NextResponse.json({ result });

  const view = await buildInboxView(account.id, account.provider);
  const mailbox = await getMailboxView(
    account.id,
    "inbox",
    parseMailboxLimit(null),
  );
  return NextResponse.json({ result, view, mailbox });
}
