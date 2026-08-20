import type { MailAccount } from "@/lib/v2/db/accounts";
import { accessTokenFor } from "@/lib/v2/providers/provider";
import {
  graphClientState,
  graphClientStateHash,
  publicAppUrl,
} from "./security";
import { upsertPushSubscription, recordPushError } from "./repository";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Graph mail subscriptions max out near 4230 minutes (~2.9 days). */
const GRAPH_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export async function registerGraphSubscription(
  account: MailAccount,
): Promise<void> {
  if (account.provider !== "microsoft") return;
  try {
    const accessToken = await accessTokenFor(account);
    const expires = new Date(Date.now() + GRAPH_TTL_MS);
    const clientState = graphClientState(account.id);
    const res = await fetch(`${GRAPH}/subscriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        changeType: "created,updated",
        notificationUrl: `${publicAppUrl()}/api/webhooks/outlook`,
        resource: "/me/mailFolders('Inbox')/messages",
        expirationDateTime: expires.toISOString(),
        clientState,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `graph subscription failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      id?: string;
      expirationDateTime?: string;
    };
    if (!json.id) throw new Error("graph subscription missing id");
    await upsertPushSubscription(account.id, "microsoft", {
      graphSubscriptionId: json.id,
      graphClientStateHash: graphClientStateHash(account.id),
      graphExpiresAt: json.expirationDateTime
        ? new Date(json.expirationDateTime)
        : expires,
      lastError: null,
    });
  } catch (e) {
    await recordPushError(
      account.id,
      e instanceof Error ? e.message : "graph subscription failed",
    );
    throw e;
  }
}

export async function renewGraphSubscription(
  account: MailAccount,
): Promise<void> {
  await registerGraphSubscription(account);
}
