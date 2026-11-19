/**
 * Opening hostile mail must stay cheap.
 *
 * The structural cleaner and the HTML-to-text pass rescan the remainder of
 * the body for every unclosed comment, processing instruction, or dangerous
 * element. These tests fail while that is true and pass once those regions
 * are dropped in linear time. A cap that still feeds a few dozen kilobytes
 * of the same input to the same expressions does not pass: ordinary HTML of
 * this size must still round-trip, and the samples below are that size.
 *
 * Run: npx tsx scripts/v3-html-redos.test.mts
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { storedBodyText, htmlToText } from "../src/lib/v2/intelligence/html-text.ts";
import { readableHtml, sanitizeStructuralHtml } from "../src/lib/v3/reader/email-html.ts";
import {
  freshBody,
  shapeThread,
  summariseThread,
} from "../src/lib/v3/reader/thread-shape.ts";
import { Reader } from "../src/components/v2/Reader.tsx";

const VISIBLE = "Visible sentence that must survive.";
const PLAIN = "Please read this.";
const OWN = "victim@victim.test";
/** Far above a linear scan of this input, far below the quadratic one. */
const BUDGET_MS = 200;
const KILL_MS = 8_000;

type Kind =
  | "sanitize"
  | "readable"
  | "text"
  | "stored-html"
  | "open"
  | "gmail"
  | "outlook"
  | "render";

type Job = {
  label: string;
  kind: Kind;
  /** Repeated opener. Each repeat is one unclosed region. */
  unit: string;
  count: number;
};

type Outcome = {
  label: string;
  ms: number;
  text: string;
  html: string;
  threw: string | null;
};

function attack(unit: string, count: number): string {
  return `<p>${VISIBLE}</p>${unit.repeat(count)}`;
}

function message(html: string, bodyText: string | null): Message {
  return {
    providerMessageId: "m1",
    from: { email: "sender@example.com", name: "Sender" },
    to: [{ email: OWN, name: "Victim" }],
    cc: [],
    sentAt: "2026-08-04T09:00:00.000Z",
    snippet: PLAIN,
    bodyHtml: html,
    bodyText,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function conversation(html: string, bodyText: string | null): Conversation {
  return {
    providerConversationId: "c1",
    subject: "Hello",
    lastMessageAt: "2026-08-04T09:00:00.000Z",
    messages: [message(html, bodyText)],
  };
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function gmailConversation(html: string): Promise<Conversation> {
  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: OWN,
    fetchImpl: async (url) => {
      const href = String(url);
      if (!href.includes("/threads/t-hostile")) {
        return new Response("missing", { status: 404 });
      }
      return Response.json({
        id: "t-hostile",
        messages: [
          {
            id: "m1",
            threadId: "t-hostile",
            snippet: PLAIN,
            labelIds: ["INBOX", "UNREAD"],
            internalDate: "1722762000000",
            payload: {
              mimeType: "multipart/alternative",
              headers: [
                { name: "From", value: "Sender <sender@example.com>" },
                { name: "To", value: "Victim <victim@victim.test>" },
                { name: "Subject", value: "Hello" },
              ],
              parts: [
                { mimeType: "text/plain", body: { data: b64url(PLAIN) } },
                { mimeType: "text/html", body: { data: b64url(html) } },
              ],
            },
          },
        ],
      });
    },
  });
  return provider.getConversation("t-hostile");
}

async function outlookConversation(html: string): Promise<Conversation> {
  const provider = new OutlookProvider({
    accessToken: "test-token",
    accountEmail: OWN,
    fetchImpl: async (url) => {
      const href = String(url);
      if (!href.includes("graph.microsoft.com") || !href.includes("/messages")) {
        return new Response("missing", { status: 404 });
      }
      return Response.json({
        value: [
          {
            id: "m1",
            conversationId: "c1",
            subject: "Hello",
            from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
            toRecipients: [
              { emailAddress: { address: "victim@victim.test", name: "Victim" } },
            ],
            ccRecipients: [],
            receivedDateTime: "2026-08-04T09:00:00Z",
            bodyPreview: PLAIN,
            body: { contentType: "html", content: html },
            isRead: false,
          },
        ],
      });
    },
  });
  return provider.getConversation("c1");
}

function openThread(html: string): { text: string; html: string } {
  const convo = conversation(html, PLAIN);
  const lanes = shapeThread(convo, "victim.test", OWN);
  summariseThread(convo, "victim.test", OWN);
  const turn = lanes.find((lane) => lane.kind === "turn");
  if (!turn || turn.kind !== "turn") throw new Error("expected an external turn");
  return { text: turn.body, html: turn.bodyHtml ?? "" };
}

async function execute(job: Job): Promise<Outcome> {
  const html = attack(job.unit, job.count);
  const started = performance.now();
  let text = "";
  let outHtml = "";
  let threw: string | null = null;
  try {
    if (job.kind === "sanitize") {
      outHtml = sanitizeStructuralHtml(html);
    } else if (job.kind === "readable") {
      outHtml = readableHtml(html).html;
    } else if (job.kind === "text") {
      text = htmlToText(html);
    } else if (job.kind === "stored-html") {
      text =
        storedBodyText({ bodyText: null, bodyHtml: html }) ?? "";
    } else if (job.kind === "open") {
      const opened = openThread(html);
      text = opened.text;
      outHtml = opened.html;
    } else if (job.kind === "gmail") {
      const loaded = await gmailConversation(html);
      const stored = loaded.messages[0];
      if (stored?.bodyText !== PLAIN) {
        throw new Error(`gmail text part was ${stored?.bodyText ?? "missing"}`);
      }
      if (!stored.bodyHtml?.includes(job.unit)) {
        throw new Error("gmail did not keep the html part");
      }
      const syncStarted = performance.now();
      const persisted = storedBodyText(stored);
      const syncMs = performance.now() - syncStarted;
      if (persisted !== PLAIN || syncMs > 50) {
        throw new Error(
          `sync scanned the html part (${Math.round(syncMs)}ms, text=${persisted?.slice(0, 40)})`,
        );
      }
      const readStarted = performance.now();
      const opened = openThread(stored.bodyHtml);
      const ms = performance.now() - readStarted;
      return {
        label: job.label,
        ms,
        text: opened.text,
        html: opened.html,
        threw: null,
      };
    } else if (job.kind === "outlook") {
      const loaded = await outlookConversation(html);
      const stored = loaded.messages[0];
      if (stored?.bodyText != null) {
        throw new Error("outlook html body was stored as text");
      }
      if (!stored?.bodyHtml?.includes(job.unit)) {
        throw new Error("outlook did not keep the html part");
      }
      text = storedBodyText(stored) ?? "";
    } else if (job.kind === "render") {
      const convo = conversation(html, PLAIN);
      outHtml = renderToString(
        createElement(Reader, {
          provider: "google",
          conversation: convo,
          ownEmail: OWN,
          onReply() {},
          onReplyAll() {},
          onForward() {},
          onArchive() {},
          onDelete() {},
        } as never),
      );
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  return {
    label: job.label,
    ms: performance.now() - started,
    text,
    html: outHtml,
    threw,
  };
}

function assertBounded(job: Job, outcome: Outcome): void {
  assert.ok(
    outcome.ms < BUDGET_MS,
    `${job.label} took ${Math.round(outcome.ms)}ms (budget ${BUDGET_MS}ms)`,
  );
  if (job.kind === "render") {
    if (outcome.threw) {
      assert.match(
        outcome.threw,
        /addHook|DOMPurify|window is not defined/,
        `${job.label} failed before the reader finished: ${outcome.threw}`,
      );
      return;
    }
    assert.match(outcome.html, new RegExp(VISIBLE), `${job.label} dropped the safe sentence`);
    assert.ok(
      outcome.html.length < 80_000,
      `${job.label} rendered ${outcome.html.length} chars`,
    );
    assert.ok(
      !outcome.html.includes(job.unit.repeat(8)),
      `${job.label} still rendered the unclosed regions`,
    );
    return;
  }
  assert.equal(outcome.threw, null, `${job.label} threw: ${outcome.threw}`);
  const body = `${outcome.html}\n${outcome.text}`;
  assert.match(body, new RegExp(VISIBLE), `${job.label} dropped the safe sentence`);
  assert.ok(
    outcome.html.length < 8_000,
    `${job.label} html is still ${outcome.html.length} chars`,
  );
  assert.ok(
    outcome.text.length < 2_000,
    `${job.label} text is still ${outcome.text.length} chars`,
  );
  assert.ok(
    !outcome.html.includes(job.unit),
    `${job.label} left an unclosed ${job.unit} region in the html`,
  );
  assert.ok(
    !outcome.text.includes(job.unit),
    `${job.label} left an unclosed ${job.unit} region in the text`,
  );
}

const VOID_TAGS = [
  "script",
  "style",
  "head",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
  "form",
  "svg",
  "math",
  "title",
] as const;

const jobs: Job[] = [
  { label: "sanitize unclosed comments", kind: "sanitize", unit: "<!--", count: 30_000 },
  { label: "sanitize unclosed processing instructions", kind: "sanitize", unit: "<?", count: 55_000 },
  ...VOID_TAGS.map(
    (tag): Job => ({
      label: `sanitize unclosed <${tag}>`,
      kind: "sanitize",
      unit: `<${tag}>`,
      count: 30_000,
    }),
  ),
  { label: "readableHtml unclosed comments", kind: "readable", unit: "<!--", count: 30_000 },
  { label: "readableHtml unclosed svg", kind: "readable", unit: "<svg>", count: 30_000 },
  { label: "htmlToText unclosed comments", kind: "text", unit: "<!--", count: 20_000 },
  ...(["script", "style", "head", "noscript"] as const).map(
    (tag): Job => ({
      label: `htmlToText unclosed <${tag}>`,
      kind: "text",
      unit: `<${tag}>`,
      count: 40_000,
    }),
  ),
  {
    label: "storedBodyText html-only unclosed comments",
    kind: "stored-html",
    unit: "<!--",
    count: 20_000,
  },
  { label: "open thread unclosed comments", kind: "open", unit: "<!--", count: 20_000 },
  { label: "open thread unclosed svg", kind: "open", unit: "<svg>", count: 30_000 },
  { label: "gmail multipart unclosed comments", kind: "gmail", unit: "<!--", count: 20_000 },
  { label: "outlook html unclosed comments", kind: "outlook", unit: "<!--", count: 20_000 },
  { label: "server render unclosed comments", kind: "render", unit: "<!--", count: 20_000 },
];

if (!isMainThread) {
  const outcome = await execute(workerData as Job);
  parentPort?.postMessage(outcome);
} else {
  const failures: string[] = [];

  // Ordinary HTML at the same scale must still survive. A cap under this
  // size would hide the quadratic samples above and blank real mail.
  {
    const chunk = "<p>Quarterly safety report paragraph with enough words to look like mail.</p>";
    let ordinary = "";
    while (ordinary.length < 80_000) ordinary += chunk;
    ordinary += "<p>ENDMARKER-VISIBLE</p>";
    const started = performance.now();
    const safe = readableHtml(ordinary);
    const opened = freshBody(message(ordinary, PLAIN));
    const ms = performance.now() - started;
    try {
      assert.ok(ms < BUDGET_MS, `ordinary html took ${Math.round(ms)}ms`);
      assert.match(safe.html, /ENDMARKER-VISIBLE/);
      assert.match(opened.text, /ENDMARKER-VISIBLE/);
      assert.doesNotMatch(safe.html, /<script/i);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Closed dangerous regions stay stripped. Skipping the cleaner is not a fix.
  {
    const safe = sanitizeStructuralHtml(
      `<p>${VISIBLE}</p><script>alert(1)</script><style>.x{color:red}</style><svg><path/></svg>`,
    );
    try {
      assert.match(safe, new RegExp(VISIBLE));
      assert.doesNotMatch(safe, /alert|color:red|<script|<style|<svg/i);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // A text part plus an html part does not run the cleaner at sync time.
  {
    const html = attack("<!--", 30_000);
    const started = performance.now();
    const persisted = storedBodyText({ bodyText: PLAIN, bodyHtml: html });
    const ms = performance.now() - started;
    try {
      assert.equal(persisted, PLAIN);
      assert.ok(ms < 50, `text-part sync took ${Math.round(ms)}ms`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  async function runJob(job: Job): Promise<void> {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: process.execArgv,
      workerData: job,
    });
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`${job.label} still running after ${KILL_MS}ms`));
      }, KILL_MS);
      worker.once("message", (message: Outcome) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assertBounded(job, outcome);
  }

  const queue = [...jobs];
  async function drain(): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        await runJob(job);
      } catch (error) {
        failures.push(`${job.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all([drain(), drain(), drain(), drain()]);

  if (failures.length > 0) {
    console.error(`v3-html-redos: ${failures.length} failed`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("v3-html-redos: OK");
}
