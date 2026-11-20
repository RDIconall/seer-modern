/**
 * Spec for the quadratic HTML tag strip used to quote a Gmail original on
 * reply / reply-all / forward, and for the same `/<[^>]+>/g` scan on other
 * attacker-supplied HTML bodies.
 *
 * These cases fail while the scan runs on the uncapped HTML part, and pass
 * once that part is capped first and converted with a linear scan.
 *
 * Not covered here (same regex, heavier session/AI wiring):
 *   src/app/api/mailbox/route.ts fetchBody
 *   src/app/api/today/route.ts fetchBody
 *   src/app/api/alltasks/route.ts fetchBody
 *   src/app/api/cron/sync/route.ts fetchBody (both call sites)
 *   src/app/api/assist/draft/route.ts
 *   src/app/api/messages/[id]/route.ts (the inline bodyText strip; extractKeyActions is covered)
 *   src/lib/v2/client/reply.ts quoteBody (no callers)
 *   src/lib/v2/providers/fake.ts (test double)
 *
 * Graph reply/forward does not use this strip (src/app/api/send/route.ts).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const TSCONFIG = path.join(HERE, "tsconfig.send-html-strip-dos.json");

/** Long enough that the quadratic `/<[^>]+>/g` scan misses a 6s child budget. */
const ATTACK_LEN = 400_000;
const CHILD_TIMEOUT_MS = 6_000;

type Probe =
  | "send-reply"
  | "send-replyAll"
  | "send-forward"
  | "send-control"
  | "htmlToText"
  | "extractKeyActions"
  | "readableHtml";

function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailHtmlOnlyMessage(html: string) {
  return {
    id: "msg-1",
    threadId: "thread-1",
    snippet: "",
    internalDate: "1700000000000",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "Victim <victim@rditrials.com>" },
        { name: "Subject", value: "Please reply" },
        { name: "Cc", value: "other@example.com" },
        { name: "Message-ID", value: "<id@example.com>" },
      ],
      parts: [
        {
          mimeType: "text/html",
          body: { data: encodeBase64Url(html) },
        },
      ],
    },
  };
}

async function runSendProbe(mode: "reply" | "replyAll" | "forward", html: string) {
  const message = gmailHtmlOnlyMessage(html);
  let sent = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/users/me/messages/send")) {
      sent = true;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1" }), {
        status: 200,
      });
    }
    if (url.includes("/users/me/messages/") && url.includes("format=full")) {
      return new Response(JSON.stringify(message), { status: 200 });
    }
    if (url.includes("/modify")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(`not mocked ${url}`, { status: 500 });
  }) as typeof fetch;

  const { getGmailMessage } = await import("../src/lib/mail/gmail.ts");
  const original = await getGmailMessage("test-access-token", "msg-1");
  assert.equal(original.textBody, "", "HTML-only mail must leave textBody empty");
  assert.equal(original.htmlBody, html, "extractBodies must keep the full HTML part");

  const { POST } = await import("../src/app/api/send/route.ts");
  const res = await POST(
    new Request("https://example.com/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        body: mode === "forward" ? "" : "Thanks",
        to: mode === "forward" ? "other@example.com" : undefined,
        replyToId: "msg-1",
      }),
    }),
  );
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(sent, true, `${mode} must reach Gmail messages.send`);
  return { sent, status: res.status };
}

async function runProbe(probe: Probe) {
  const attack = "<".repeat(ATTACK_LEN);
  if (probe === "send-reply") return runSendProbe("reply", attack);
  if (probe === "send-replyAll") return runSendProbe("replyAll", attack);
  if (probe === "send-forward") return runSendProbe("forward", attack);
  if (probe === "send-control") {
    return runSendProbe("reply", "<p>hello from attacker</p>");
  }
  if (probe === "htmlToText") {
    const { storedBodyText } = await import(
      "../src/lib/v2/intelligence/html-text.ts"
    );
    storedBodyText({ bodyText: null, bodyHtml: attack });
    return { sent: true, status: 200 };
  }
  if (probe === "extractKeyActions") {
    const { extractKeyActions } = await import("../src/lib/inbox/key-actions.ts");
    extractKeyActions(
      `<a href="https://example.com/track">${attack}</a>`,
      "track",
    );
    return { sent: true, status: 200 };
  }
  if (probe === "readableHtml") {
    const { readableHtml } = await import("../src/lib/v3/reader/email-html.ts");
    readableHtml(attack);
    return { sent: true, status: 200 };
  }
  throw new Error(`unknown probe ${probe}`);
}

const childProbe = process.env.SEER_HTML_STRIP_PROBE as Probe | undefined;
if (childProbe) {
  const result = await runProbe(childProbe);
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  const nodeRequire = createRequire(import.meta.url);
  const tsxCli = path.join(
    path.dirname(nodeRequire.resolve("tsx/package.json")),
    "dist/cli.mjs",
  );

  function runChild(probe: Probe) {
    const result = spawnSync(
      process.execPath,
      [tsxCli, "--tsconfig", TSCONFIG, SELF],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: { ...process.env, SEER_HTML_STRIP_PROBE: probe },
      },
    );
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        assert.fail(
          `${probe} still running after ${CHILD_TIMEOUT_MS}ms — the tag strip blocked before the operation finished`,
        );
      }
      throw result.error;
    }
    if (result.status !== 0) {
      assert.fail(
        `${probe} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(line) as { sent?: boolean; status?: number };
    assert.equal(parsed.status, 200, `${probe} ${line}`);
    assert.equal(parsed.sent, true, `${probe} ${line}`);
  }

  console.log("html tag-strip DoS");

  let failures = 0;
  async function check(name: string, fn: () => void) {
    try {
      fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  await check(
    "control: HTML-only Gmail reply with ordinary tags reaches Gmail",
    () => runChild("send-control"),
  );
  await check(
    "reply of an HTML-only body of less-than signs reaches Gmail in budget",
    () => runChild("send-reply"),
  );
  await check(
    "replyAll of an HTML-only body of less-than signs reaches Gmail in budget",
    () => runChild("send-replyAll"),
  );
  await check(
    "forward of an HTML-only body of less-than signs reaches Gmail in budget",
    () => runChild("send-forward"),
  );
  await check(
    "v2 storedBodyText converts HTML-only less-than signs in budget",
    () => runChild("htmlToText"),
  );
  await check(
    "extractKeyActions scans an anchor filled with less-than signs in budget",
    () => runChild("extractKeyActions"),
  );
  await check(
    "v3 readableHtml handles a body of less-than signs in budget",
    () => runChild("readableHtml"),
  );

  if (failures) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}
