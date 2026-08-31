/**
 * Gate: background work fans out one invocation per mailbox. A shared tick is
 * how one backlog stalled every other desk; company rollout needs a pipe each.
 */
import assert from "node:assert/strict";
import {
  accountWorkerUrl,
  cronOrigin,
  fanOutPerAccount,
} from "../src/lib/v2/cron/fan-out.ts";

assert.equal(cronOrigin({}), null);
assert.equal(
  cronOrigin({ AUTH_URL: "https://seer.example" }),
  "https://seer.example",
);
assert.equal(
  cronOrigin({ VERCEL_URL: "seer-modern.vercel.app" }),
  "https://seer-modern.vercel.app",
);

const worker = accountWorkerUrl(
  "https://seer.example",
  "/api/v2/read",
  "11111111-1111-1111-1111-111111111111",
);
assert.equal(
  worker,
  "https://seer.example/api/v2/read?accountId=11111111-1111-1111-1111-111111111111",
);
assert.match(
  accountWorkerUrl("https://seer.example", "/api/v2/sync", "abc", {
    mode: "full",
  }),
  /mode=full/,
);

const accounts = [
  { id: "aa", email: "a@example.com" },
  { id: "bb", email: "b@example.com" },
  { id: "cc", email: "c@example.com" },
];

{
  const started: string[] = [];
  const local = await fanOutPerAccount({
    accounts,
    path: "/api/v2/read",
    authorization: null,
    origin: null,
    runLocal: async (accountId) => {
      started.push(accountId);
      if (accountId === "aa") throw new Error("aa exploded");
      return { decided: 1, accountId };
    },
  });
  assert.equal(local.length, 3);
  assert.equal(local.find((row) => row.email === "a@example.com")?.ok, false);
  assert.equal(local.find((row) => row.email === "b@example.com")?.ok, true);
  assert.equal(
    local.find((row) => row.email === "c@example.com")?.result?.decided,
    1,
  );
  assert.deepEqual(started.sort(), ["aa", "bb", "cc"]);
}

{
  const urls: string[] = [];
  const remote = await fanOutPerAccount({
    accounts,
    path: "/api/v2/read",
    authorization: "Bearer secret",
    origin: "https://seer.example",
    runLocal: async () => {
      throw new Error("must not run locally when origin is set");
    },
    fetchImpl: (async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(
        (init as RequestInit | undefined)?.headers &&
          (init as RequestInit).headers &&
          new Headers((init as RequestInit).headers).get("authorization"),
        "Bearer secret",
      );
      const id = new URL(url).searchParams.get("accountId");
      return new Response(JSON.stringify({ ok: true, report: { id } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(remote.length, 3);
  assert.ok(remote.every((row) => row.ok));
  assert.deepEqual(
    urls.sort(),
    [
      "https://seer.example/api/v2/read?accountId=aa",
      "https://seer.example/api/v2/read?accountId=bb",
      "https://seer.example/api/v2/read?accountId=cc",
    ].sort(),
  );
}

console.log("v2-cron-fanout: OK");
