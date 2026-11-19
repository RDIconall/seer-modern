/**
 * Spec for the tag-strip denial of service.
 *
 * An HTML-only message whose body is a long run of "<" (no ">") makes
 * /<[^>]+>/g scan the rest of the string at every less-than. These tests
 * drive the product functions that do that scan. They fail while that
 * expression still runs on the uncapped body, and they pass once the scan
 * is capped and linear.
 *
 * Run:
 *   node --experimental-vm-modules --import tsx scripts/tag-strip-dos.test.mts
 *
 * Left untested, same expression, not on the attack path exercised here:
 * - src/app/api/cron/sync/route.ts (both copies). The handler returns before
 *   any mailbox read unless SEER_LEGACY_CRON=on, which defaults to off.
 * - src/lib/v2/client/reply.ts quoteBody. Nothing in the app calls it.
 * - src/lib/v2/providers/fake.ts. The input is the signed-in user's own
 *   outgoing compose body in the fake provider, not an inbound message.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import vm from "node:vm";
import { NextResponse } from "next/server";
import { htmlToText, storedBodyText } from "../src/lib/v2/intelligence/html-text.ts";
import { messageFromReadRow } from "../src/lib/v2/intelligence/load-conversation.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { shapeThread } from "../src/lib/v3/reader/thread-shape.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ATTACK_CHARS = 40_000;
const BUDGET_MS = 800;
const MESSAGE_ID = "msg-attack";
const THREAD_ID = "thread-attack";
let currentMessageId = MESSAGE_ID;

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-tag-strip-"));
process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";
process.env.GEMINI_API_KEY = "placeholder-not-a-secret";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.POSTGRES_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_TOKEN;

const attackHtml = "<".repeat(ATTACK_CHARS);
const anchoredHtml = `<a href="https://example.com/track">${"<".repeat(ATTACK_CHARS)}</a>`;

type Session = {
  accessToken: string;
  provider: "google" | "microsoft-entra-id";
  email: string;
  name: string;
  accountId: string;
};

let currentSession: Session = {
  accessToken: "placeholder-token",
  provider: "google",
  email: "victim@example.com",
  name: "Victim",
  accountId: "account-1",
};

const pendingAfter: Promise<unknown>[] = [];

function installFetch(html: string, plain: string) {
  const handler: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      return Response.json({ id: "sent-1", threadId: THREAD_ID });
    }
    if (url.includes("graph.microsoft.com")) {
      return Response.json(graphMessage(html, plain));
    }
    const requested = messageIdFrom(url);
    if (url.includes("format=full") && url.includes("/threads/")) {
      return Response.json({
        id: THREAD_ID,
        messages: [gmailFull(html, plain, requested)],
      });
    }
    if (url.includes("format=minimal") && url.includes("/threads/")) {
      return Response.json({ id: THREAD_ID, messages: [{ id: requested }] });
    }
    if (url.includes("format=metadata") && url.includes("/threads/")) {
      return Response.json({
        id: THREAD_ID,
        messages: [
          {
            id: requested,
            internalDate: "1700000000000",
            labelIds: ["INBOX"],
            payload: { headers: [{ name: "From", value: "Attacker <attacker@example.com>" }] },
          },
        ],
      });
    }
    if (url.includes("format=full")) {
      return Response.json(gmailFull(html, plain, requested));
    }
    if (url.includes("format=metadata")) {
      return Response.json(gmailMetadata(requested));
    }
    if (url.includes("/messages?") || url.includes("/threads?")) {
      const query = decodeURIComponent(url);
      const inbox = /in:inbox/.test(query) && !/-in:inbox/.test(query);
      return Response.json(
        inbox
          ? {
              messages: [{ id: currentMessageId, threadId: THREAD_ID }],
              threads: [{ id: THREAD_ID }],
            }
          : { messages: [], threads: [] },
      );
    }
    if (url.includes("/labels")) {
      return Response.json({ labels: [] });
    }
    return Response.json({});
  };
  globalThis.fetch = handler;
  context.fetch = handler;
}

function b64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailHeaders() {
  return [
    { name: "From", value: "Attacker <attacker@example.com>" },
    { name: "To", value: "Victim <victim@example.com>" },
    { name: "Subject", value: "Hello" },
    { name: "Message-ID", value: "<m@example.com>" },
  ];
}

function messageIdFrom(url: string): string {
  const match = url.match(/\/messages\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : currentMessageId;
}

function gmailFull(html: string, plain: string, id = currentMessageId) {
  const parts = [];
  if (plain) {
    parts.push({
      mimeType: "text/plain",
      body: { data: b64url(plain), size: plain.length },
    });
  }
  if (html) {
    parts.push({
      mimeType: "text/html",
      body: { data: b64url(html), size: html.length },
    });
  }
  const single = parts.length === 1;
  return {
    id,
    threadId: THREAD_ID,
    snippet: plain.slice(0, 80),
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: single
      ? { mimeType: parts[0].mimeType, headers: gmailHeaders(), body: parts[0].body }
      : { mimeType: "multipart/alternative", headers: gmailHeaders(), parts },
  };
}

function gmailMetadata(id = currentMessageId) {
  return {
    id,
    threadId: THREAD_ID,
    snippet: "",
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: { headers: gmailHeaders() },
  };
}

function graphMessage(html: string, plain: string) {
  const htmlOnly = html.length > 0 && plain.length === 0;
  return {
    id: currentMessageId,
    conversationId: THREAD_ID,
    subject: "Hello",
    bodyPreview: plain,
    body: htmlOnly
      ? { contentType: "html", content: html }
      : { contentType: "text", content: plain },
    receivedDateTime: "2026-01-01T00:00:00.000Z",
    isRead: false,
    hasAttachments: false,
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { address: "victim@example.com", name: "Victim" } }],
    ccRecipients: [],
    internetMessageId: "<m@example.com>",
  };
}

const context = vm.createContext({
  console,
  Buffer,
  process,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  performance,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  fetch: globalThis.fetch,
  Request,
  Response,
  Headers,
  AbortSignal,
  AbortController,
  structuredClone,
  btoa,
  atob,
  crypto,
});

const compiled = new Map<string, vm.SourceTextModule>();
const synthetic = new Map<string, vm.SyntheticModule>();

function exportNames(value: object): string[] {
  return [...new Set([...Object.keys(value), ...Object.getOwnPropertyNames(value)])].filter(
    (name) => name !== "default" && name !== "__esModule",
  );
}

async function syntheticFor(key: string, value: Record<string, unknown>) {
  const existing = synthetic.get(key);
  if (existing) return existing;
  const names = exportNames(value);
  const hasDefault = "default" in value;
  const mod = new vm.SyntheticModule(
    hasDefault ? [...names, "default"] : names,
    function () {
      for (const name of names) this.setExport(name, value[name]);
      if (hasDefault) this.setExport("default", value.default);
    },
    { identifier: key, context },
  );
  synthetic.set(key, mod);
  await mod.link(() => {
    throw new Error(`synthetic module ${key} cannot import`);
  });
  return mod;
}

function resolveFile(specifier: string, parentHref: string): string | null {
  if (specifier.startsWith("@/")) {
    return path.join(ROOT, "src", specifier.slice(2));
  }
  if (specifier.startsWith(".")) {
    const parentPath = parentHref.startsWith("file:")
      ? fileURLToPath(parentHref)
      : parentHref;
    return path.resolve(path.dirname(parentPath), specifier);
  }
  return null;
}

function withExtension(file: string): string {
  if (path.extname(file) && existsSync(file)) return file;
  for (const ext of [".ts", ".tsx", ".mts", ".js", ".mjs"]) {
    if (existsSync(file + ext)) return file + ext;
  }
  for (const ext of [".ts", ".tsx", ".js"]) {
    const index = path.join(file, "index" + ext);
    if (existsSync(index)) return index;
  }
  return file;
}

async function linker(specifier: string, referencing: vm.Module): Promise<vm.Module> {
  if (specifier === "ai") {
    return syntheticFor("ai", {
      Output: { object: (schema: unknown) => schema },
      async generateText() {
        return { output: { body: "Thanks." }, text: "" };
      },
    });
  }
  if (specifier === "next/server") {
    return syntheticFor("next/server", {
      NextResponse,
      after(task: () => unknown) {
        const pending = Promise.resolve().then(() => task());
        pendingAfter.push(pending);
        return pending;
      },
    });
  }
  if (specifier === "@/lib/mail/session") {
    return syntheticFor("@/lib/mail/session", {
      async requireMailSession() {
        return currentSession;
      },
    });
  }

  const parent = referencing.identifier;
  const local = resolveFile(specifier, parent);
  if (local) {
    const file = withExtension(local);
    const hit = compiled.get(file);
    if (hit) return hit;
    const source = readFileSync(file, "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
      },
      fileName: file,
    }).outputText;
    const mod = new vm.SourceTextModule(js, {
      identifier: pathToFileURL(file).href,
      context,
    });
    compiled.set(file, mod);
    return mod;
  }

  const key = `pkg:${specifier}`;
  const existing = synthetic.get(key);
  if (existing) return existing;
  const imported = (await import(specifier)) as Record<string, unknown>;
  return syntheticFor(key, imported);
}

async function loadRoute(rel: string): Promise<Record<string, unknown>> {
  const file = path.join(ROOT, rel);
  const cached = compiled.get(file);
  if (cached) {
    return cached.namespace as Record<string, unknown>;
  }
  const source = readFileSync(file, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    fileName: file,
  }).outputText;
  const mod = new vm.SourceTextModule(js, {
    identifier: pathToFileURL(file).href,
    context,
  });
  compiled.set(file, mod);
  if (mod.status === "unlinked") await mod.link(linker);
  if (mod.status === "linked") await mod.evaluate();
  return mod.namespace as Record<string, unknown>;
}

const failures: string[] = [];

async function withinBudget(name: string, run: () => Promise<void>) {
  pendingAfter.length = 0;
  const started = performance.now();
  try {
    await run();
    if (pendingAfter.length > 0) await Promise.all(pendingAfter);
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    failures.push(`${name} threw after ${ms}ms: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const ms = Math.round(performance.now() - started);
  if (ms >= BUDGET_MS) {
    failures.push(`${name} took ${ms}ms (budget ${BUDGET_MS}ms)`);
  } else {
    console.log(`ok ${name} ${ms}ms`);
  }
}

function attackMessage(html: string | null, text: string | null): Message {
  return {
    providerMessageId: MESSAGE_ID,
    from: { email: "attacker@example.com", name: "Attacker" },
    to: [{ email: "victim@example.com" }],
    cc: [],
    sentAt: "2026-01-01T00:00:00.000Z",
    snippet: "",
    bodyHtml: html,
    bodyText: text,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function attackConversation(message: Message): Conversation {
  return {
    providerConversationId: THREAD_ID,
    subject: "Hello",
    messages: [message],
    lastMessageAt: message.sentAt,
  };
}

async function postDraft() {
  const route = await loadRoute("src/app/api/assist/draft/route.ts");
  const POST = route.POST as (request: Request) => Promise<Response>;
  const response = await POST(
    new Request("http://localhost/api/assist/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: currentMessageId }),
    }),
  );
  const json = (await response.json()) as { body?: string; error?: string };
  assert.equal(response.status, 200, json.error ?? "draft status");
  assert.equal(json.body, "Thanks.");
}

async function main() {
  const draft = await loadRoute("src/app/api/assist/draft/route.ts");
  assert.equal(typeof draft.POST, "function");

  installFetch("<p>Please send the contract.</p>", "");
  await withinBudget("draft route strips ordinary html", postDraft);

  installFetch("", "a".repeat(ATTACK_CHARS));
  await withinBudget("draft route skips the scan when a plain part exists", postDraft);

  installFetch(attackHtml, "");
  currentSession = { ...currentSession, provider: "google" };
  await withinBudget("draft route html-only gmail less-than run", postDraft);

  installFetch(attackHtml, "");
  currentSession = { ...currentSession, provider: "microsoft-entra-id" };
  await withinBudget("draft route html-only graph empty preview", postDraft);

  installFetch(attackHtml, "A short preview that is not the body.");
  currentSession = { ...currentSession, provider: "microsoft-entra-id" };
  await withinBudget("draft route graph non-empty preview does not scan html", postDraft);

  currentSession = { ...currentSession, provider: "google" };

  const messages = await loadRoute("src/app/api/messages/[id]/route.ts");
  const GET = messages.GET as (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  async function getMessage() {
    const response = await GET(new Request("http://localhost/api/messages/" + currentMessageId), {
      params: Promise.resolve({ id: currentMessageId }),
    });
    assert.ok(response.status < 500, `message status ${response.status}`);
  }
  installFetch("<p>Please send the contract.</p>", "");
  await withinBudget("message route ordinary html", getMessage);
  installFetch(attackHtml, "");
  await withinBudget("message route html-only less-than run", getMessage);
  installFetch(anchoredHtml, "Please track the package");
  await withinBudget("message route anchor inner less-than run", getMessage);

  const send = await loadRoute("src/app/api/send/route.ts");
  const sendPost = send.POST as (request: Request) => Promise<Response>;
  async function reply() {
    const response = await sendPost(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "reply",
          body: "On it.",
          replyToId: currentMessageId,
        }),
      }),
    );
    assert.ok(response.status < 500, `send status ${response.status}`);
  }
  installFetch(attackHtml, "");
  await withinBudget("send route reply quotes html-only less-than run", reply);

  const mailbox = await loadRoute("src/app/api/mailbox/route.ts");
  const today = await loadRoute("src/app/api/today/route.ts");
  const alltasks = await loadRoute("src/app/api/alltasks/route.ts");
  currentMessageId = "msg-mailbox";
  currentSession = { ...currentSession, email: "mailbox@example.com", provider: "google" };
  installFetch(attackHtml, "");
  await withinBudget("mailbox route deferred body scan", async () => {
    const response = await (mailbox.GET as (request: Request) => Promise<Response>)(
      new Request("http://localhost/api/mailbox"),
    );
    assert.ok(response.status < 500, `mailbox status ${response.status}`);
  });
  currentMessageId = "msg-today";
  currentSession = { ...currentSession, email: "today@example.com", provider: "google" };
  installFetch(attackHtml, "");
  await withinBudget("today route deferred body scan", async () => {
    const response = await (today.GET as () => Promise<Response>)();
    assert.ok(response.status < 500, `today status ${response.status}`);
  });
  currentMessageId = "msg-alltasks";
  currentSession = { ...currentSession, email: "alltasks@example.com", provider: "google" };
  installFetch(attackHtml, "");
  await withinBudget("alltasks route body scan", async () => {
    const response = await (alltasks.GET as () => Promise<Response>)();
    assert.ok(response.status < 500, `alltasks status ${response.status}`);
  });

  await withinBudget("gmail sync html-only body becomes stored text", async () => {
    installFetch(attackHtml, "");
    const provider = new GmailProvider({
      accessToken: "placeholder-token",
      accountEmail: "victim@example.com",
      fetchImpl: globalThis.fetch,
    });
    const conversation = await provider.getConversation(THREAD_ID);
    const message = conversation.messages[0];
    assert.equal(message.bodyText, null);
    assert.equal(message.bodyHtml?.length, ATTACK_CHARS);
    const text = storedBodyText(message);
    assert.equal(typeof text, "string");
  });

  await withinBudget("outlook sync html body becomes stored text", async () => {
    const provider = new OutlookProvider({
      accessToken: "placeholder-token",
      accountEmail: "victim@example.com",
      fetchImpl: async () =>
        Response.json({
          value: [
            {
              id: MESSAGE_ID,
              conversationId: THREAD_ID,
              subject: "Hello",
              bodyPreview: "ignored by the v2 adapter",
              body: { contentType: "html", content: attackHtml },
              receivedDateTime: "2026-01-01T00:00:00.000Z",
              isRead: false,
              from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
              toRecipients: [{ emailAddress: { address: "victim@example.com" } }],
            },
          ],
        }),
    });
    const conversation = await provider.getConversation(THREAD_ID);
    const message = conversation.messages[0];
    assert.equal(message.bodyText, null);
    assert.equal(message.bodyHtml?.length, ATTACK_CHARS);
    const text = storedBodyText(message);
    assert.equal(typeof text, "string");
  });

  await withinBudget("reading a stored html-only row", () => {
    const row = messageFromReadRow({
      provider_message_id: MESSAGE_ID,
      from_email: "attacker@example.com",
      from_name: "Attacker",
      to_emails: ["victim@example.com"],
      cc_emails: [],
      sent_at: "2026-01-01T00:00:00.000Z",
      body_html: attackHtml,
      body_text: null,
      snippet: "",
      is_unread: true,
      is_outgoing: false,
      attachment_names: [],
    });
    assert.ok(row);
    assert.equal(typeof row?.bodyText, "string");
    return Promise.resolve();
  });

  await withinBudget("reader shapes an html-only less-than body", () => {
    const lanes = shapeThread(
      attackConversation(attackMessage(attackHtml, null)),
      "example.com",
      "victim@example.com",
    );
    assert.equal(lanes.length, 1);
    return Promise.resolve();
  });

  await withinBudget("htmlToText ordinary paragraph", () => {
    assert.equal(htmlToText("<p>Please send the contract.</p>"), "Please send the contract.");
    return Promise.resolve();
  });

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

await main();
