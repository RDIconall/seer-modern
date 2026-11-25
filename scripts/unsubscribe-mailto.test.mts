import assert from "node:assert/strict";
import { classifyMessage } from "../src/lib/inbox/classify.ts";
import {
  unsubscribeGmail,
  unsubscribeGraph,
  type UnsubscribeResult,
} from "../src/lib/mail/unsubscribe.ts";

/**
 * Spec for List-Unsubscribe mailto handling.
 *
 * These tests fail while unsubscribe copies the mailto path into the
 * provider recipient list and the mailto subject into the outgoing
 * subject. They pass once a mailto send happens only for a single
 * address whose domain matches the message From or Return-Path (or is
 * a subdomain of one of those), and the outgoing subject is exactly
 * "unsubscribe".
 *
 * The mailbox is stubbed at HTTP. Header parsing, URL parsing, MIME
 * construction, Graph recipient splitting, and the send request all run
 * the product code.
 */

const TOKEN = "placeholder-token";
const FIXED_SUBJECT = "unsubscribe";

let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
    );
  }
}

type Header = { name: string; value: string };
type Call = { url: string; method: string; body: string };

function useFetch(
  reply: (url: string, method: string) => Response,
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ??
      (typeof input !== "string" && !(input instanceof URL)
        ? input.method
        : "GET")
    ).toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return reply(url, method);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function gmailMailbox(headers: Header[]): string {
  return JSON.stringify({ payload: { headers } });
}

function graphMailbox(headers: Header[]): string {
  return JSON.stringify({ internetMessageHeaders: headers });
}

function isGmailRead(url: string): boolean {
  return (
    url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/") &&
    !url.includes("/messages/send")
  );
}

function isGraphRead(url: string): boolean {
  return (
    url.startsWith("https://graph.microsoft.com/v1.0/me/messages/") &&
    !url.includes("/sendMail")
  );
}

function isMailSend(call: Call): boolean {
  return (
    call.method === "POST" &&
    (call.url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" ||
      call.url === "https://graph.microsoft.com/v1.0/me/sendMail")
  );
}

function gmailMime(body: string): string {
  const raw = (JSON.parse(body) as { raw?: string }).raw ?? "";
  assert.ok(raw, "Gmail send had no raw MIME");
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
}

function mimeHeaders(mime: string): string[] {
  const end = mime.indexOf("\r\n\r\n");
  assert.ok(end >= 0, "MIME has no header block");
  return mime.slice(0, end).split("\r\n");
}

function describeSend(call: Call): string {
  if (call.url.includes("gmail")) {
    const mime = gmailMime(call.body);
    const headers = mimeHeaders(mime);
    const to = headers.filter((line) => /^to:/i.test(line));
    const subject = headers.filter((line) => /^subject:/i.test(line));
    const extra = headers.filter((line) => /^(cc|bcc):/i.test(line));
    return `Gmail ${to.join(" | ")} ${subject.join(" | ")} ${extra.join(" | ")}`.trim();
  }
  const message = (
    JSON.parse(call.body) as {
      message?: {
        subject?: string;
        toRecipients?: { emailAddress?: { address?: string } }[];
        ccRecipients?: unknown;
      };
    }
  ).message;
  const to = (message?.toRecipients ?? [])
    .map((recipient) => recipient.emailAddress?.address)
    .join(", ");
  return `Graph subject=${JSON.stringify(message?.subject)} to=${to} cc=${message?.ccRecipients ? "yes" : "no"}`;
}

function headersFor(opts: {
  mailto: string;
  from?: string;
  returnPath?: string;
  listPost?: string;
  https?: string;
}): Header[] {
  const links = [
    opts.https ? `<${opts.https}>` : "",
    `<${opts.mailto}>`,
  ]
    .filter(Boolean)
    .join(", ");
  const headers: Header[] = [
    { name: "List-Unsubscribe", value: links },
  ];
  if (opts.from) headers.push({ name: "From", value: opts.from });
  if (opts.returnPath) {
    headers.push({ name: "Return-Path", value: opts.returnPath });
  }
  if (opts.listPost) {
    headers.push({ name: "List-Unsubscribe-Post", value: opts.listPost });
  }
  return headers;
}

async function runGmail(
  messageId: string,
  headers: Header[],
  extra?: (url: string, method: string) => Response | undefined,
): Promise<{ result: UnsubscribeResult; calls: Call[] }> {
  const body = gmailMailbox(headers);
  const calls = useFetch((url, method) => {
    const special = extra?.(url, method);
    if (special) return special;
    if (method === "GET" && isGmailRead(url)) return new Response(body, { status: 200 });
    if (isMailSend({ url, method, body: "" })) {
      return jsonResponse({ id: "sent-id", threadId: "thread-id" });
    }
    return new Response("unexpected", { status: 500 });
  });
  const result = await unsubscribeGmail(TOKEN, messageId);
  return { result, calls };
}

async function runGraph(
  messageId: string,
  headers: Header[],
  extra?: (url: string, method: string) => Response | undefined,
): Promise<{ result: UnsubscribeResult; calls: Call[] }> {
  const body = graphMailbox(headers);
  const calls = useFetch((url, method) => {
    const special = extra?.(url, method);
    if (special) return special;
    if (method === "GET" && isGraphRead(url)) return new Response(body, { status: 200 });
    if (isMailSend({ url, method, body: "" })) {
      return new Response("", { status: 202 });
    }
    return new Response("unexpected", { status: 500 });
  });
  const result = await unsubscribeGraph(TOKEN, messageId);
  return { result, calls };
}

function assertReadThenNoSend(
  calls: Call[],
  messageId: string,
  provider: "gmail" | "graph",
) {
  const read = calls.filter(
    (call) =>
      call.method === "GET" &&
      call.url.includes(messageId) &&
      (provider === "gmail" ? isGmailRead(call.url) : isGraphRead(call.url)),
  );
  assert.equal(read.length, 1, "unsubscribe never read the stored message");
  const sends = calls.filter(isMailSend);
  assert.deepEqual(
    sends.map(describeSend),
    [],
    "mailto unsubscribe sent mail",
  );
  assert.equal(
    calls.filter((call) => call.method === "POST" && isMailSend(call)).length,
    0,
  );
}

function assertSingleCleanSend(calls: Call[], to: string) {
  const sends = calls.filter(isMailSend);
  assert.equal(sends.length, 1, `expected one send, saw ${sends.map(describeSend).join("; ")}`);
  const call = sends[0];
  if (call.url.includes("gmail")) {
    const mime = gmailMime(call.body);
    const headers = mimeHeaders(mime);
    assert.deepEqual(
      headers.filter((line) => /^to:/i.test(line)),
      [`To: ${to}`],
    );
    assert.deepEqual(
      headers.filter((line) => /^subject:/i.test(line)),
      [`Subject: ${FIXED_SUBJECT}`],
    );
    assert.deepEqual(
      headers.filter((line) => /^(cc|bcc):/i.test(line)),
      [],
    );
    assert.equal(mime.slice(mime.indexOf("\r\n\r\n") + 4), FIXED_SUBJECT);
    assert.equal(mime.includes("\nBcc:"), false);
    assert.equal(mime.includes("\nCc:"), false);
    return;
  }
  const message = (
    JSON.parse(call.body) as {
      message?: {
        subject?: string;
        body?: { content?: string };
        toRecipients?: { emailAddress?: { address?: string } }[];
        ccRecipients?: unknown[];
      };
    }
  ).message;
  assert.equal(message?.subject, FIXED_SUBJECT);
  assert.equal(message?.body?.content, FIXED_SUBJECT);
  assert.deepEqual(
    (message?.toRecipients ?? []).map((recipient) => recipient.emailAddress?.address),
    [to],
  );
  assert.equal(message?.ccRecipients, undefined);
}

const ATTACK_SUBJECT = "Updated remittance details - please use new account from today";
const ATTACK_MAILTO = `mailto:cfo@company.example,ap@company.example,client@partner.example?subject=${encodeURIComponent(ATTACK_SUBJECT)}`;

console.log("unsubscribe mailto");

await check(
  "rules grader offers Unsubscribe for a marketing sender that says unsubscribe",
  async () => {
    const graded = classifyMessage({
      fromEmail: "news@news.attacker.example",
      fromName: "Weekly",
      subject: "Your weekly briefing",
      snippet: "You can unsubscribe at any time",
    });
    assert.equal(graded.action, "unsubscribe");
    assert.equal(graded.debug.ruleId, "marketing-unsubscribe");
  },
);

await check(
  "Gmail does not send a comma-separated mailto list or its subject",
  async () => {
    const { calls } = await runGmail(
      "msg-gmail-list",
      headersFor({
        mailto: ATTACK_MAILTO,
        from: "Weekly <news@news.attacker.example>",
        returnPath: "<bounce@news.attacker.example>",
      }),
    );
    assertReadThenNoSend(calls, "msg-gmail-list", "gmail");
  },
);

await check(
  "Graph does not send a comma-separated mailto list or its subject",
  async () => {
    const { calls } = await runGraph(
      "msg-graph-list",
      headersFor({
        mailto: ATTACK_MAILTO,
        from: "Weekly <news@news.attacker.example>",
        returnPath: "<bounce@news.attacker.example>",
      }),
    );
    assertReadThenNoSend(calls, "msg-graph-list", "graph");
  },
);

await check(
  "Gmail does not send when the mailto path uses semicolons",
  async () => {
    const { calls } = await runGmail(
      "msg-gmail-semi",
      headersFor({
        mailto:
          "mailto:cfo@company.example;ap@company.example?subject=Please%20pay",
        from: "News <news@attacker.example>",
        returnPath: "<bounce@attacker.example>",
      }),
    );
    assertReadThenNoSend(calls, "msg-gmail-semi", "gmail");
  },
);

await check(
  "Graph splits neither commas nor semicolons into recipients",
  async () => {
    const { calls } = await runGraph(
      "msg-graph-semi",
      headersFor({
        mailto:
          "mailto:cfo@company.example;ap@company.example?subject=Please%20pay",
        from: "News <news@attacker.example>",
        returnPath: "<bounce@attacker.example>",
      }),
    );
    assertReadThenNoSend(calls, "msg-graph-semi", "graph");
  },
);

await check(
  "a matching first address does not authorize the rest of a comma list",
  async () => {
    const headers = headersFor({
      mailto:
        "mailto:unsub@brand.example,cfo@company.example?subject=Updated%20account",
      from: "News <news@brand.example>",
      returnPath: "<bounce@brand.example>",
    });
    const gmail = await runGmail("msg-gmail-partial", headers);
    assertReadThenNoSend(gmail.calls, "msg-gmail-partial", "gmail");
    const graph = await runGraph("msg-graph-partial", headers);
    assertReadThenNoSend(graph.calls, "msg-graph-partial", "graph");
  },
);

await check(
  "an address with more than one at-sign is not sent",
  async () => {
    const headers = headersFor({
      mailto: "mailto:user@brand.example@attacker.example?subject=unsubscribe",
      from: "News <news@brand.example>",
      returnPath: "<bounce@brand.example>",
    });
    const gmail = await runGmail("msg-gmail-ats", headers);
    assertReadThenNoSend(gmail.calls, "msg-gmail-ats", "gmail");
    const graph = await runGraph("msg-graph-ats", headers);
    assertReadThenNoSend(graph.calls, "msg-graph-ats", "graph");
  },
);

await check(
  "a single recipient on another domain is not sent",
  async () => {
    const headers = headersFor({
      mailto: `mailto:cfo@company.example?subject=${encodeURIComponent(ATTACK_SUBJECT)}`,
      from: "News <news@attacker.example>",
      returnPath: "<bounce@attacker.example>",
    });
    const gmail = await runGmail("msg-gmail-foreign", headers);
    assertReadThenNoSend(gmail.calls, "msg-gmail-foreign", "gmail");
    const graph = await runGraph("msg-graph-foreign", headers);
    assertReadThenNoSend(graph.calls, "msg-graph-foreign", "graph");
  },
);

await check(
  "a domain that merely ends with the sender domain is not a subdomain",
  async () => {
    const headers = headersFor({
      mailto: "mailto:unsub@notbrand.example?subject=unsubscribe",
      from: "News <news@brand.example>",
      returnPath: "<bounce@brand.example>",
    });
    const gmail = await runGmail("msg-gmail-suffix", headers);
    assertReadThenNoSend(gmail.calls, "msg-gmail-suffix", "gmail");
    const graph = await runGraph("msg-graph-suffix", headers);
    assertReadThenNoSend(graph.calls, "msg-graph-suffix", "graph");
  },
);

await check(
  "a parent domain of From is not close enough",
  async () => {
    const headers = headersFor({
      mailto: "mailto:unsub@brand.example?subject=unsubscribe",
      from: "News <news@email.brand.example>",
      returnPath: "<bounce@email.brand.example>",
    });
    const gmail = await runGmail("msg-gmail-parent", headers);
    assertReadThenNoSend(gmail.calls, "msg-gmail-parent", "gmail");
    const graph = await runGraph("msg-graph-parent", headers);
    assertReadThenNoSend(graph.calls, "msg-graph-parent", "graph");
  },
);

await check(
  "Gmail sends one same-domain unsubscribe and drops the header subject",
  async () => {
    const { result, calls } = await runGmail(
      "msg-gmail-ok",
      headersFor({
        mailto: "mailto:unsub@brand.example?subject=PLEASE%20CLICK%20HERE",
        from: "News <news@brand.example>",
        returnPath: "<bounce@brand.example>",
      }),
    );
    assert.equal(result.method, "mailto");
    assertSingleCleanSend(calls, "unsub@brand.example");
  },
);

await check(
  "Graph sends one same-domain unsubscribe and drops the header subject",
  async () => {
    const { result, calls } = await runGraph(
      "msg-graph-ok",
      headersFor({
        mailto: "mailto:unsub@brand.example?subject=PLEASE%20CLICK%20HERE",
        from: "News <news@brand.example>",
        returnPath: "<bounce@brand.example>",
      }),
    );
    assert.equal(result.method, "mailto");
    assertSingleCleanSend(calls, "unsub@brand.example");
  },
);

await check(
  "a subdomain of From may receive the fixed unsubscribe subject",
  async () => {
    const headers = headersFor({
      mailto: "mailto:unsub@email.brand.example?subject=PLEASE%20CLICK%20HERE",
      from: "News <news@brand.example>",
      returnPath: "<bounce@brand.example>",
    });
    const gmail = await runGmail("msg-gmail-sub", headers);
    assert.equal(gmail.result.method, "mailto");
    assertSingleCleanSend(gmail.calls, "unsub@email.brand.example");
    const graph = await runGraph("msg-graph-sub", headers);
    assert.equal(graph.result.method, "mailto");
    assertSingleCleanSend(graph.calls, "unsub@email.brand.example");
  },
);

await check(
  "Return-Path domain authorizes a send when From does not match",
  async () => {
    const headers = headersFor({
      mailto: "mailto:unsub@brand.example?subject=PLEASE%20CLICK%20HERE",
      from: "News <news@attacker.example>",
      returnPath: "<bounce@brand.example>",
    });
    const gmail = await runGmail("msg-gmail-rp", headers);
    assert.equal(gmail.result.method, "mailto");
    assertSingleCleanSend(gmail.calls, "unsub@brand.example");
    const graph = await runGraph("msg-graph-rp", headers);
    assert.equal(graph.result.method, "mailto");
    assertSingleCleanSend(graph.calls, "unsub@brand.example");
  },
);

await check(
  "a decoded subject cannot add a Bcc line on the Gmail MIME",
  async () => {
    const { result, calls } = await runGmail(
      "msg-gmail-bcc",
      headersFor({
        mailto:
          "mailto:unsub@brand.example?subject=Hello%0D%0ABcc%3A%20cfo%40company.example",
        from: "News <news@brand.example>",
        returnPath: "<bounce@brand.example>",
      }),
    );
    assert.equal(result.method, "mailto");
    const mime = gmailMime(calls.filter(isMailSend)[0].body);
    assert.equal(
      mime.toLowerCase().includes("bcc:"),
      false,
      `injected header in MIME:\n${mime}`,
    );
    assert.equal(mime.includes("cfo@company.example"), false);
    assertSingleCleanSend(calls, "unsub@brand.example");
  },
);

await check(
  "Graph does not keep a subject taken from the mailto header",
  async () => {
    const { result, calls } = await runGraph(
      "msg-graph-subj",
      headersFor({
        mailto:
          "mailto:unsub@brand.example?subject=Hello%0D%0ABcc%3A%20cfo%40company.example",
        from: "News <news@brand.example>",
        returnPath: "<bounce@brand.example>",
      }),
    );
    assert.equal(result.method, "mailto");
    assertSingleCleanSend(calls, "unsub@brand.example");
    const raw = calls.filter(isMailSend)[0].body;
    assert.equal(raw.includes("cfo@company.example"), false);
  },
);

await check(
  "a failed one-click POST does not fall through into a malicious mailto send",
  async () => {
    const headers = headersFor({
      mailto: ATTACK_MAILTO,
      https: "https://lists.example/unsub",
      listPost: "List-Unsubscribe=One-Click",
      from: "News <news@attacker.example>",
      returnPath: "<bounce@attacker.example>",
    });
    const extra = (url: string, method: string) =>
      url === "https://lists.example/unsub" && method === "POST"
        ? new Response("no", { status: 500 })
        : undefined;
    const gmail = await runGmail("msg-gmail-fall", headers, extra);
    assert.ok(
      gmail.calls.some(
        (call) =>
          call.url === "https://lists.example/unsub" && call.method === "POST",
      ),
    );
    assertReadThenNoSend(gmail.calls, "msg-gmail-fall", "gmail");
    const graph = await runGraph("msg-graph-fall", headers, extra);
    assert.ok(
      graph.calls.some(
        (call) =>
          call.url === "https://lists.example/unsub" && call.method === "POST",
      ),
    );
    assertReadThenNoSend(graph.calls, "msg-graph-fall", "graph");
  },
);

await check(
  "a successful one-click POST does not also send mailto",
  async () => {
    const headers = headersFor({
      mailto: "mailto:unsub@brand.example?subject=PLEASE%20CLICK%20HERE",
      https: "https://lists.example/unsub",
      listPost: "List-Unsubscribe=One-Click",
      from: "News <news@brand.example>",
      returnPath: "<bounce@brand.example>",
    });
    const extra = (url: string, method: string) =>
      url === "https://lists.example/unsub" && method === "POST"
        ? new Response("ok", { status: 200 })
        : undefined;
    const gmail = await runGmail("msg-gmail-click", headers, extra);
    assert.equal(gmail.result.method, "one-click");
    assert.equal(gmail.calls.filter(isMailSend).length, 0);
    const graph = await runGraph("msg-graph-click", headers, extra);
    assert.equal(graph.result.method, "one-click");
    assert.equal(graph.calls.filter(isMailSend).length, 0);
  },
);

await check(
  "each stored message is its own send, so a second malicious header is also refused",
  async () => {
    const first = await runGmail(
      "msg-a",
      headersFor({
        mailto: "mailto:cfo@company.example,ap@company.example?subject=One",
        from: "News <news@attacker.example>",
        returnPath: "<bounce@attacker.example>",
      }),
    );
    assertReadThenNoSend(first.calls, "msg-a", "gmail");
    const second = await runGraph(
      "msg-b",
      headersFor({
        mailto: "mailto:client@partner.example?subject=Two",
        from: "News <news@attacker.example>",
        returnPath: "<bounce@attacker.example>",
      }),
    );
    assertReadThenNoSend(second.calls, "msg-b", "graph");
  },
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
