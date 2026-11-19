/**
 * One tag-stripping case. The parent kills this worker if it is still
 * running after the time budget. A pass is a message posted before that.
 *
 * The bodies are the Gmail and Graph payloads the product already parses.
 * HTML-only mail has an empty text part, so the task list, reader, send,
 * draft, and sync paths strip the HTML before they shorten it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { mock } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ATTACK_CHARS = 250_000;
const CASE = String((workerData as { caseName?: string }).caseName ?? "");

const dataDir = mkdtempSync(path.join(tmpdir(), "seer-tag-strip-"));
process.env.SEER_DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "placeholder-not-a-secret";
process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";
process.env.SEER_LEGACY_CRON = CASE.startsWith("cron") ? "on" : "off";
process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = CASE.startsWith("cron") ? "1" : "0";
for (const name of [
  "POSTGRES_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "CRON_SECRET",
]) {
  delete process.env[name];
}

const benignHtml = "<p>Please review the contract today.</p>";
const attackHtml = "<".repeat(ATTACK_CHARS);
const anchorHtml =
  `<a href="https://example.com/pay">${"<".repeat(ATTACK_CHARS)}</a>`;

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type Bodies = { plain?: string; html?: string };

function gmailMessage(bodies: Bodies, format: "full" | "metadata") {
  const headers = [
    { name: "From", value: "Attacker <attacker@example.com>" },
    { name: "To", value: "Victim <victim@example.com>" },
    { name: "Subject", value: "Hello" },
    { name: "Message-ID", value: "<m1@example.com>" },
  ];
  const base = {
    id: "m1",
    threadId: "t1",
    snippet: "preview",
    internalDate: "1710000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/html",
      headers,
      body: { size: 0 },
    },
  };
  if (format === "metadata") return base;
  if (bodies.plain && bodies.html) {
    return {
      ...base,
      payload: {
        mimeType: "multipart/alternative",
        headers,
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64url(bodies.plain), size: bodies.plain.length },
          },
          {
            mimeType: "text/html",
            body: { data: b64url(bodies.html), size: bodies.html.length },
          },
        ],
      },
    };
  }
  const html = bodies.html ?? "";
  return {
    ...base,
    payload: {
      mimeType: "text/html",
      headers,
      body: { data: b64url(html), size: html.length },
    },
  };
}

function bodiesForCase(): Bodies {
  if (CASE.includes("benign")) {
    return { html: benignHtml };
  }
  if (CASE === "messages-anchor") {
    return { plain: "Please pay the invoice.", html: anchorHtml };
  }
  return { html: attackHtml };
}

function graphMessage(preview: string) {
  const html = CASE.includes("benign") ? benignHtml : attackHtml;
  return {
    id: "m1",
    conversationId: "t1",
    subject: "Hello",
    bodyPreview: preview,
    body: { contentType: "html", content: html },
    receivedDateTime: "2026-08-01T12:00:00Z",
    isRead: false,
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { name: "Victim", address: "victim@example.com" } }],
    ccRecipients: [],
    internetMessageId: "<m1@example.com>",
    hasAttachments: false,
  };
}

function listItem() {
  return {
    id: "m1",
    conversationId: "t1",
    subject: "Hello",
    bodyPreview: CASE === "alltasks-graph" ? "" : "preview",
    receivedDateTime: "2026-08-01T12:00:00Z",
    isRead: false,
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { address: "victim@example.com" } }],
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(bodies: Bodies) {
  const full = gmailMessage(bodies, "full");
  const meta = gmailMessage(bodies, "metadata");
  const graph = graphMessage(
    CASE === "alltasks-graph" || CASE.includes("benign") ? "" : "preview",
  );
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("gmail.googleapis.com")) {
      if (method === "POST") return jsonResponse({ id: "sent1", threadId: "t1" });
      if (url.includes("/users/me/labels")) return jsonResponse({ labels: [] });
      if (url.includes("/labels/INBOX")) {
        return jsonResponse({ messagesTotal: 1, threadsTotal: 1 });
      }
      if (url.includes("/threads/")) {
        if (url.includes("format=minimal")) {
          return jsonResponse({ messages: [{ id: "m1" }] });
        }
        if (url.includes("format=full")) {
          return jsonResponse({ id: "t1", messages: [full] });
        }
        return jsonResponse({
          messages: [
            {
              id: "m1",
              internalDate: "1710000000000",
              labelIds: ["INBOX"],
              payload: { headers: meta.payload.headers },
            },
          ],
        });
      }
      if (url.includes("/messages/m1")) {
        return jsonResponse(url.includes("format=full") ? full : meta);
      }
      if (url.includes("/messages?")) {
        const q = decodeURIComponent(url);
        if (q.includes("-in:inbox") || q.includes("in:sent") || q.includes("in:trash")) {
          return jsonResponse({ messages: [] });
        }
        if (q.includes("in:inbox")) {
          return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
        }
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({});
    }
    if (url.includes("graph.microsoft.com")) {
      if (url.includes("/me/messages/m1")) return jsonResponse(graph);
      if (url.includes("$filter=")) return jsonResponse({ value: [graph] });
      if (url.includes("/contacts") || url.includes("/calendarView")) {
        return jsonResponse({ value: [] });
      }
      if (url.includes("/mailFolders/")) {
        return jsonResponse({ value: [listItem()], totalItemCount: 1 });
      }
      return jsonResponse({ value: [] });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return jsonResponse({ models: [] });
    }
    if (
      url.includes("people.googleapis.com") ||
      url.includes("www.googleapis.com/calendar")
    ) {
      return jsonResponse({ connections: [], otherContacts: [], items: [] });
    }
    console.error("unmocked fetch", method, url.slice(0, 200));
    return jsonResponse({});
  };
}

const deferred: Array<() => Promise<unknown>> = [];

const session = {
  accessToken: "placeholder-access-token",
  provider: CASE.includes("graph") ? "microsoft-entra-id" : "google",
  email: "victim@example.com",
  name: "Victim",
  accountId: "acct-1",
};

const nextServer = await import("next/dist/server/web/spec-extension/response.js");
mock.module("next/server", {
  namedExports: {
    NextResponse: nextServer.NextResponse,
    after(task: () => Promise<unknown>) {
      deferred.push(task);
    },
  },
});
mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => session,
  },
});
mock.module("ai", {
  namedExports: {
    generateText: async () => ({
      output: {
        items: [],
        records: [],
        body: "Thanks.",
        matters: [],
        summary: "",
        themes: [],
      },
    }),
    Output: { object: () => ({}) },
  },
});

installFetch(bodiesForCase());

async function finish(response: Response, extra?: Record<string, unknown>) {
  const text = await response.text();
  let body: unknown = text.slice(0, 300);
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the slice */
  }
  const summary = summarize(body);
  if (CASE.startsWith("today") || CASE.startsWith("mailbox")) {
    for (const task of deferred) await task();
  }
  parentPort?.postMessage({
    ok: response.status === 200 && summary.ok,
    status: response.status,
    summary,
    ...extra,
  });
}

function summarize(body: unknown): { ok: boolean; detail: string } {
  if (CASE.startsWith("alltasks") || CASE === "cron-gmail") {
    if (CASE.startsWith("alltasks")) {
      const tasks = body as { id?: string }[];
      const found = Array.isArray(tasks) && tasks.some((task) => task.id === "m1");
      return { ok: found, detail: found ? "task m1" : "task list missing m1" };
    }
    const report = body as { ok?: boolean; disabled?: string; report?: { error?: string }[] };
    if (report.disabled) return { ok: false, detail: report.disabled };
    const error = report.report?.find((row) => row.error)?.error;
    if (error) return { ok: false, detail: error };
    return { ok: report.ok === true, detail: report.ok ? "cron finished" : "cron not ok" };
  }
  if (CASE.startsWith("messages")) {
    const parsed = body as { message?: { id?: string } };
    const found = parsed.message?.id === "m1";
    return { ok: found, detail: found ? "message m1" : "reader missing m1" };
  }
  if (CASE.startsWith("send")) {
    const parsed = body as { ok?: boolean; id?: string };
    return {
      ok: parsed.ok === true && Boolean(parsed.id),
      detail: parsed.ok ? "sent" : "send failed",
    };
  }
  if (CASE.startsWith("assist")) {
    const parsed = body as { body?: string; replyToId?: string };
    return {
      ok: Boolean(parsed.body) && parsed.replyToId === "m1",
      detail: parsed.body ? "draft" : "draft missing",
    };
  }
  if (CASE.startsWith("today") || CASE.startsWith("mailbox")) {
    const parsed = body as {
      inbox?: { id?: string }[];
      items?: { id?: string }[];
    };
    const rows = parsed.inbox ?? parsed.items ?? [];
    const found = rows.some((row) => row.id === "m1");
    return {
      ok: found && deferred.length > 0,
      detail: found
        ? `listed m1, deferred ${deferred.length}`
        : "deferred response missing m1",
    };
  }
  return { ok: true, detail: "done" };
}

async function runRoute() {
  if (CASE.startsWith("cron")) {
    writeFileSync(
      path.join(dataDir, "accounts.json"),
      JSON.stringify({
        accounts: [
          {
            id: "acct-1",
            provider: "google",
            email: "victim@example.com",
            name: "Victim",
            accessToken: "placeholder-access-token",
            expiresAt: 2_000_000_000,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const route = await import("../src/app/api/cron/sync/route.ts");
    const response = await route.GET(new Request("http://localhost/api/cron/sync"));
    await finish(response);
    return;
  }
  if (CASE.startsWith("alltasks")) {
    const route = await import("../src/app/api/alltasks/route.ts");
    await finish(await route.GET());
    return;
  }
  if (CASE.startsWith("today")) {
    const route = await import("../src/app/api/today/route.ts");
    await finish(await route.GET());
    return;
  }
  if (CASE.startsWith("mailbox")) {
    const route = await import("../src/app/api/mailbox/route.ts");
    await finish(await route.GET(new Request("http://localhost/api/mailbox")));
    return;
  }
  if (CASE.startsWith("messages")) {
    const route = await import("../src/app/api/messages/[id]/route.ts");
    await finish(
      await route.GET(new Request("http://localhost/api/messages/m1"), {
        params: Promise.resolve({ id: "m1" }),
      }),
    );
    return;
  }
  if (CASE.startsWith("send")) {
    const route = await import("../src/app/api/send/route.ts");
    await finish(
      await route.POST(
        new Request("http://localhost/api/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "reply",
            replyToId: "m1",
            body: "On it.",
            to: "attacker@example.com",
          }),
        }),
      ),
    );
    return;
  }
  if (CASE.startsWith("assist")) {
    const route = await import("../src/app/api/assist/draft/route.ts");
    await finish(
      await route.POST(
        new Request("http://localhost/api/assist/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "m1", intent: "yes" }),
        }),
      ),
    );
    return;
  }
  throw new Error(`unknown route case ${CASE}`);
}

async function runV2() {
  const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
  const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
  const { storedBodyText } = await import("../src/lib/v2/intelligence/html-text.ts");
  const { shapeThread } = await import("../src/lib/v3/reader/thread-shape.ts");
  const { quoteBody } = await import("../src/lib/v2/client/reply.ts");
  const html = CASE === "v2-benign" ? benignHtml : attackHtml;
  const gmail = new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: "victim@example.com",
    fetchImpl: fetch,
  });
  const outlook = new OutlookProvider({
    accessToken: "placeholder-access-token",
    accountEmail: "victim@example.com",
    fetchImpl: fetch,
  });
  const gmailThread = await gmail.getConversation("t1");
  const outlookThread = await outlook.getConversation("t1");
  const gmailText = storedBodyText({
    bodyText: gmailThread.messages[0]?.bodyText ?? null,
    bodyHtml: gmailThread.messages[0]?.bodyHtml ?? null,
  });
  const outlookText = storedBodyText({
    bodyText: outlookThread.messages[0]?.bodyText ?? null,
    bodyHtml: outlookThread.messages[0]?.bodyHtml ?? null,
  });
  const gmailLanes = shapeThread(gmailThread, "example.com", "victim@example.com");
  const outlookLanes = shapeThread(outlookThread, "victim.example", "victim@example.com");
  const quoted = quoteBody(gmailThread);
  const benign = CASE === "v2-benign";
  const readable =
    (gmailText ?? "").includes("Please review") &&
    (outlookText ?? "").includes("Please review") &&
    quoted.includes("Please review");
  parentPort?.postMessage({
    ok: benign
      ? readable && gmailLanes.length > 0 && outlookLanes.length > 0
      : typeof gmailText === "string" &&
        typeof outlookText === "string" &&
        gmailLanes.length > 0 &&
        outlookLanes.length > 0 &&
        quoted.length > 0,
    summary: {
      ok: true,
      detail: benign ? "benign text kept" : "sync and reader finished",
    },
  });
}

try {
  if (CASE.startsWith("v2")) await runV2();
  else await runRoute();
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    status: 0,
    summary: {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    },
  });
}
