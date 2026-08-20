import type { MailAccount } from "@/lib/v2/db/accounts";
import { accessTokenFor } from "@/lib/v2/providers/provider";
import { gmailPubSubTopic } from "./security";
import { upsertPushSubscription, recordPushError } from "./repository";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function registerGmailWatch(account: MailAccount): Promise<void> {
  if (account.provider !== "google") return;
  const topic = gmailPubSubTopic();
  if (!topic) {
    await upsertPushSubscription(account.id, "google", {
      lastError: "GMAIL_PUBSUB_TOPIC not configured",
    });
    return;
  }
  try {
    const accessToken = await accessTokenFor(account);
    const res = await fetch(`${GMAIL}/watch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        topicName: topic,
        labelIds: ["INBOX"],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`gmail watch failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      historyId?: string;
      expiration?: string;
    };
    await upsertPushSubscription(account.id, "google", {
      gmailHistoryId: json.historyId ?? null,
      gmailWatchExpiresAt: json.expiration
        ? new Date(Number(json.expiration))
        : new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      lastError: null,
    });
  } catch (e) {
    await recordPushError(
      account.id,
      e instanceof Error ? e.message : "gmail watch failed",
    );
    throw e;
  }
}

export async function renewGmailWatch(account: MailAccount): Promise<void> {
  await registerGmailWatch(account);
}
