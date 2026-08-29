import { NextResponse, after } from "next/server";
import { asAccountId } from "@/lib/v2/db/types";
import {
  claimWake,
  getPushByGraphSubscriptionId,
} from "@/lib/v2/push/repository";
import { clientStateMatches } from "@/lib/v2/push/security";
import { wakeAccount } from "@/lib/v2/sync/wake-account";

export const maxDuration = 30;

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
    value?: GraphNotification[];
  } | null;
  const notifications = body?.value ?? [];
  const toWake = new Set<string>();
  let deferred = 0;
  let firstError: unknown;

  for (const note of notifications) {
    if (!note.subscriptionId) continue;
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
