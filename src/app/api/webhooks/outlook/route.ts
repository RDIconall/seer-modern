import { NextResponse, after } from "next/server";
import { asAccountId } from "@/lib/v2/db/types";
import {
  claimWake,
  getPushByGraphSubscriptionId,
} from "@/lib/v2/push/repository";
import {
  clientStateMatches,
  isPlausibleGraphClientState,
  isPlausibleGraphSubscriptionId,
} from "@/lib/v2/push/security";
import { wakeAccount } from "@/lib/v2/sync/wake-account";

export const maxDuration = 30;

/**
 * The endpoint is anonymous, so every entry is attacker-sized work against the
 * shared pool. Entries past this prefix are acknowledged but ignored; missed
 * mail is recovered by reconciliation and wakes are deduped per account.
 */
const MAX_NOTIFICATIONS_PER_REQUEST = 16;

type GraphNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
};

/**
 * Microsoft Graph change notifications for Inbox.
 * Handshake: echo validationToken. Otherwise validate clientState and wake.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  const body = (await request.json().catch(() => null)) as {
    value?: unknown;
  } | null;
  const raw = body?.value;
  const notifications: unknown[] = Array.isArray(raw)
    ? raw.slice(0, MAX_NOTIFICATIONS_PER_REQUEST)
    : [];
  const toWake = new Set<string>();
  const seen = new Set<string>();
  let deferred = 0;
  let firstError: unknown;

  for (const entry of notifications) {
    if (!entry || typeof entry !== "object") continue;
    const note = entry as GraphNotification;
    if (!isPlausibleGraphSubscriptionId(note.subscriptionId)) continue;
    if (!isPlausibleGraphClientState(note.clientState)) continue;
    if (seen.has(note.subscriptionId)) continue;
    seen.add(note.subscriptionId);
    try {
      const push = await getPushByGraphSubscriptionId(note.subscriptionId);
      if (!push) continue;
      if (!clientStateMatches(push.accountId, note.clientState)) continue;
      if (await claimWake(push.accountId)) {
        toWake.add(push.accountId);
      }
    } catch (error) {
      // Graph retries every non-2xx response. If Postgres or its pooler is
      // unavailable, returning 500 turns one notification into a retry storm
      // while the reconciliation job will recover the missed mail anyway.
      deferred += 1;
      firstError ??= error;
    }
  }

  if (deferred > 0) {
    console.error(
      "[seer] Outlook webhook deferred notifications; reconciliation will recover them",
      {
        deferred,
        error:
          firstError instanceof Error
            ? firstError.message.slice(0, 200)
            : "notification lookup failed",
      },
    );
  }

  if (toWake.size > 0) {
    const accountIds = [...toWake].map((id) => asAccountId(id));
    after(async () => {
      for (const id of accountIds) {
        await wakeAccount(id);
      }
    });
  }

  return NextResponse.json({ ok: true, waking: toWake.size, deferred });
}
