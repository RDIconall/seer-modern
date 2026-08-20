import { NextResponse, after } from "next/server";
import { claimWake } from "@/lib/v2/push/repository";
import { getAccountByEmail, wakeAccount } from "@/lib/v2/sync/wake-account";
import { asAccountId } from "@/lib/v2/db/types";

export const maxDuration = 30;

type PubSubPushBody = {
  message?: {
    data?: string;
    messageId?: string;
  };
};

/**
 * Gmail Pub/Sub push. Payload is base64 JSON `{ emailAddress, historyId }`.
 * Returns 200 quickly so Pub/Sub does not retry; wake runs in the background.
 *
 * Requires GMAIL_PUBSUB_TOPIC and a GCP push subscription aimed at this URL.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as PubSubPushBody | null;
  const data = body?.message?.data;
  if (!data) {
    return NextResponse.json({ ok: true, ignored: "empty" });
  }

  let emailAddress = "";
  try {
    const decoded = JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as { emailAddress?: string; historyId?: string };
    emailAddress = (decoded.emailAddress ?? "").toLowerCase();
  } catch {
    return NextResponse.json({ ok: true, ignored: "bad payload" });
  }

  if (!emailAddress) {
    return NextResponse.json({ ok: true, ignored: "no email" });
  }

  const account = await getAccountByEmail(emailAddress);
  if (!account || account.provider !== "google") {
    // Unknown address — ack so Pub/Sub stops retrying.
    return NextResponse.json({ ok: true, ignored: "unknown account" });
  }

  if (!(await claimWake(account.id))) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const accountId = asAccountId(account.id);
  after(async () => {
    await wakeAccount(accountId);
  });

  return NextResponse.json({ ok: true, waking: account.email });
}
