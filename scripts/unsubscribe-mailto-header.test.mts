import assert from "node:assert/strict";
import { unsubscribeGmail } from "../src/lib/mail/unsubscribe.ts";

/**
 * Spec for the mailto unsubscribe header injection.
 *
 * A List-Unsubscribe mailto subject is percent-decoded and copied into the
 * raw Gmail MIME. These tests describe the safe outcome: either no message
 * is sent, or the message posted to Gmail's send method is a single
 * text/plain unsubscribe whose header block is only To, Subject,
 * MIME-Version, and Content-Type, and whose body is the application's
 * own "unsubscribe" text.
 *
 * They fail while a decoded CR or LF in that subject can open a new header
 * or replace the body.
 */

const TOKEN = "placeholder-access-token";

type Call = {
  url: string;
  method: string;
  body?: string;
  authorization?: string;
};

function installFetch(headers: { name: string; value: string }[]) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    calls.push({ url, method, body, authorization: auth ?? undefined });
    if (
      url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
    ) {
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/")) {
      return new Response(JSON.stringify({ payload: { headers } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("upstream failed", { status: 502 });
  }) as typeof fetch;
  return calls;
}

function sentMimes(calls: Call[]): string[] {
  return calls
    .filter(
      (call) =>
        call.method === "POST" &&
        call.url.startsWith(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        ),
    )
    .map((call) => {
      assert.equal(
        call.authorization,
        `Bearer ${TOKEN}`,
        "send must use the signed-in mailbox token",
      );
      const raw = (JSON.parse(call.body ?? "{}") as { raw?: string }).raw;
      assert.equal(typeof raw, "string", "gmail send body had no raw message");
      const decoded = Buffer.from(
        raw!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      assert.equal(
        Buffer.from(decoded, "utf8")
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
        raw,
        "raw field must be the base64url encoding of the MIME text",
      );
      return decoded;
    });
}

/** Header block ends at the first CR, LF, or CRLF blank line. */
function assertSafeUnsubscribe(mime: string) {
  const lines = mime.split(/\r\n|\n|\r/);
  const blank = lines.indexOf("");
  assert.notEqual(blank, -1, `no header terminator:\n${mime}`);
  const headers = lines.slice(0, blank);
  const body = lines.slice(blank + 1).join("\n").replace(/\n$/, "");
  const names = headers.map((line) => {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `broken header line ${JSON.stringify(line)}\n${mime}`);
    return line.slice(0, colon);
  });
  assert.deepEqual(
    [...names].sort(),
    ["Content-Type", "MIME-Version", "Subject", "To"],
    `header block changed:\n${mime}`,
  );
  assert.equal(body, "unsubscribe", `body was replaced:\n${mime}`);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

console.log("unsubscribe mailto header injection");

await check("a normal mailto unsubscribe is a plain text note to that mailbox", async () => {
  const calls = installFetch([
    {
      name: "List-Unsubscribe",
      value: "<mailto:list@news.test?subject=Please%20unsubscribe>",
    },
  ]);
  const result = await unsubscribeGmail(TOKEN, "msg-benign");
  assert.deepEqual(result, { method: "mailto" });
  const mimes = sentMimes(calls);
  assert.equal(mimes.length, 1);
  assertSafeUnsubscribe(mimes[0]);
  assert.match(mimes[0], /^To: list@news\.test\r\nSubject: Please unsubscribe\r\n/);
});

await check(
  "percent-encoded CRLF in the mailto subject cannot add a Bcc or a new body",
  async () => {
    const calls = installFetch([
      {
        name: "List-Unsubscribe",
        value:
          "<mailto:spy@evil.test?subject=Unsubscribe%0D%0ABcc:spy@evil.test%0D%0A%0D%0AForged%20body%20the%20victim%20never%20wrote>",
      },
    ]);
    await unsubscribeGmail(TOKEN, "msg-crlf");
    for (const mime of sentMimes(calls)) assertSafeUnsubscribe(mime);
  },
);

await check(
  "a bare LF in the mailto subject cannot open another header",
  async () => {
    const calls = installFetch([
      {
        name: "list-unsubscribe",
        value: "<mailto:spy@evil.test?subject=Unsubscribe%0ACc:spy@evil.test>",
      },
    ]);
    await unsubscribeGmail(TOKEN, "msg-lf");
    for (const mime of sentMimes(calls)) assertSafeUnsubscribe(mime);
  },
);

await check(
  "a bare CR in the mailto subject cannot open another header",
  async () => {
    const calls = installFetch([
      {
        name: "List-Unsubscribe",
        value: "<mailto:spy@evil.test?subject=Unsubscribe%0DTo:other@evil.test>",
      },
    ]);
    await unsubscribeGmail(TOKEN, "msg-cr");
    for (const mime of sentMimes(calls)) assertSafeUnsubscribe(mime);
  },
);

await check(
  "a mailto subject that is only a blank line cannot replace the body",
  async () => {
    const calls = installFetch([
      {
        name: "List-Unsubscribe",
        value: "<mailto:spy@evil.test?subject=%0d%0a%0d%0aForged%20note>",
      },
    ]);
    await unsubscribeGmail(TOKEN, "msg-body");
    for (const mime of sentMimes(calls)) assertSafeUnsubscribe(mime);
  },
);

await check(
  "a failed one-click POST still must not send the injected mailto subject",
  async () => {
    const calls = installFetch([
      {
        name: "List-Unsubscribe",
        value:
          "<https://lists.example/unsub>, <mailto:spy@evil.test?subject=Hi%0ABcc:spy@evil.test%0A%0AForged>",
      },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
    await unsubscribeGmail(TOKEN, "msg-fallthrough");
    const oneClick = calls.filter((call) => call.url === "https://lists.example/unsub");
    assert.equal(oneClick.length, 1, "one-click was not attempted");
    assert.equal(oneClick[0]?.method, "POST");
    for (const mime of sentMimes(calls)) assertSafeUnsubscribe(mime);
  },
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
