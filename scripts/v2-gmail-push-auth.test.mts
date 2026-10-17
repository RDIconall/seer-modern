/**
 * Gmail Pub/Sub push must not wake a mailbox for an unauthenticated POST.
 * Outlook already checks clientState; Gmail should require a shared secret
 * or a Google OIDC bearer token when those env vars are configured.
 *
 * When no Gmail push auth env is set, unsigned POSTs still ack (legacy),
 * so existing GCP subscriptions keep filling the inbox via this path
 * until the operator adds the token to the push URL.
 */
import assert from "node:assert/strict";
import {
  gmailPushAuthorized,
  GMAIL_PUSH_TOKEN_ENV,
  GMAIL_PUSH_AUDIENCE_ENV,
} from "../src/lib/v2/push/gmail-push-auth.ts";

const body = JSON.stringify({
  message: { data: Buffer.from(JSON.stringify({ emailAddress: "a@b.c" })).toString("base64") },
});

function req(headers: Record<string, string> = {}, url = "https://seer.example/api/webhooks/gmail") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

delete process.env[GMAIL_PUSH_TOKEN_ENV];
delete process.env[GMAIL_PUSH_AUDIENCE_ENV];
assert.equal(GMAIL_PUSH_TOKEN_ENV, "GMAIL_PUBSUB_VERIFICATION_TOKEN");
assert.equal(GMAIL_PUSH_AUDIENCE_ENV, "GMAIL_PUSH_AUDIENCE");

assert.equal(
  (await gmailPushAuthorized(req(), { production: true })).ok,
  true,
  "unsigned is accepted until an auth secret is configured (do not break current push)",
);

process.env[GMAIL_PUSH_TOKEN_ENV] = "s3cret-token";
try {
  assert.equal(
    (await gmailPushAuthorized(req(), { production: true })).ok,
    false,
    "unsigned is rejected once a verification token is set",
  );
  assert.equal(
    (
      await gmailPushAuthorized(req({ authorization: "Bearer s3cret-token" }), {
        production: true,
      })
    ).ok,
    true,
    "shared secret as Bearer is accepted",
  );
  assert.equal(
    (
      await gmailPushAuthorized(
        req({}, "https://seer.example/api/webhooks/gmail?token=s3cret-token"),
        { production: true },
      )
    ).ok,
    true,
    "shared secret as query token is accepted",
  );
  assert.equal(
    (
      await gmailPushAuthorized(req({ "x-seer-pubsub-token": "s3cret-token" }), {
        production: true,
      })
    ).ok,
    true,
    "shared secret as header is accepted",
  );
  assert.equal(
    (await gmailPushAuthorized(req({ authorization: "Bearer wrong" }), { production: true }))
      .ok,
    false,
    "wrong secret is rejected",
  );
} finally {
  delete process.env[GMAIL_PUSH_TOKEN_ENV];
}

const { POST } = await import("../src/app/api/webhooks/gmail/route.ts");
process.env[GMAIL_PUSH_TOKEN_ENV] = "route-token";
try {
  const denied = await POST(
    new Request("https://example.com/api/webhooks/gmail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  assert.equal(denied.status, 401, "gmail webhook route rejects unsigned POSTs when configured");
} finally {
  delete process.env[GMAIL_PUSH_TOKEN_ENV];
}

console.log("v2-gmail-push-auth: OK");
