/**
 * Mail sync design for replacing legacy Akka processors (no runtime here).
 *
 * Gmail: prefer Google Cloud Pub/Sub push to HTTPS endpoint
 * (users.watch + subscription) for near-real-time; fallback short polling
 * of history.list when Pub/Sub is unavailable.
 *
 * Microsoft: Graph change notifications (webhook) on /messages with
 * clientState secret; renew subscriptions before expiry; delta query
 * for catch-up.
 *
 * Outbound: Gmail users.messages.send with RFC822; Graph sendMail.
 *
 * Heavy work: enqueue to a durable queue (Vercel Workflow, SQS, or Cloud
 * Tasks) — do not run full sync inside a single serverless invocation.
 */

export const GMAIL_SYNC = {
  mode: "pubsub_preferred" as const,
  watchScope: "https://www.googleapis.com/auth/gmail.readonly",
};

export const GRAPH_SYNC = {
  mode: "change_notifications" as const,
  resource: "/me/messages",
};
