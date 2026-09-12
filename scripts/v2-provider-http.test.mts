import assert from "node:assert/strict";
import {
  ProviderHttpError,
  providerFetch,
} from "../src/lib/v2/providers/http.ts";

let attempts = 0;
const quotaThenSuccess = (async () => {
  attempts += 1;
  if (attempts === 1) {
    return new Response(
      JSON.stringify({
        error: {
          code: 403,
          message:
            "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
        },
      }),
      { status: 403 },
    );
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof fetch;

const recovered = await providerFetch(
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  { method: "GET" },
  {
    provider: "gmail",
    fetchImpl: quotaThenSuccess,
    sleep: async () => {},
  },
);
assert.deepEqual(recovered, { ok: true });
assert.equal(attempts, 2, "quota-limited Gmail reads should retry");

let forbiddenAttempts = 0;
const forbidden = (async () => {
  forbiddenAttempts += 1;
  return new Response('{"error":{"message":"Forbidden"}}', { status: 403 });
}) as unknown as typeof fetch;

await assert.rejects(
  () =>
    providerFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { method: "GET" },
      {
        provider: "gmail",
        fetchImpl: forbidden,
        sleep: async () => {},
      },
    ),
  (error: unknown) =>
    error instanceof ProviderHttpError && error.status === 403,
);
assert.equal(
  forbiddenAttempts,
  1,
  "ordinary permission 403 responses must not retry",
);

console.log("v2-provider-http: OK");
