import type { MailAccount } from "@/lib/v2/db/accounts";
import { registerGmailWatch } from "./gmail-watch";
import { registerGraphSubscription } from "./graph-subscription";

/**
 * Register (or refresh) provider push for an account. Failures are recorded on
 * the push row and never block sign-in — the 5-minute cron remains the safety
 * net until push is healthy.
 */
export async function ensurePushForAccount(account: MailAccount): Promise<void> {
  try {
    if (account.provider === "microsoft") {
      await registerGraphSubscription(account);
    } else if (account.provider === "google") {
      await registerGmailWatch(account);
    }
  } catch (e) {
    console.error(
      "[seer] push register failed",
      account.email,
      e instanceof Error ? e.message : e,
    );
  }
}
