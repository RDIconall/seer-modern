/**
 * Unvalidated List-Unsubscribe navigation.
 *
 * Run from the repo root:
 *   node --experimental-test-module-mocks --import tsx scripts/unsubscribe-redirect.test.mts
 *
 * These tests are the spec for the fix. They fail while the product opens
 * a List-Unsubscribe http(s) URL on the first Unsubscribe click, or hands
 * a non-public host back as a link.
 *
 * Safe contract:
 * - The Unsubscribe menu item, useMailbox().unsubscribe, and
 *   teachSender(..., "unsubscribe") must not navigate on that action.
 *   Navigation means window.open, location.assign / replace, or changing
 *   location.href.
 * - A public http(s) target (no working one-click, or one-click that did
 *   not succeed) stays available for the user to read. After the action,
 *   mailbox.toast or mailbox.pendingUnsubscribeUrl contains the exact URL
 *   string taken from the header.
 * - mailbox.confirmPendingUnsubscribe(url) is the second confirmation. It
 *   may navigate only when url is exactly that pending public URL. Any
 *   other argument must not navigate.
 * - A non-public host must not come back from unsubscribeGmail,
 *   unsubscribeGraph, or POST /api/unsubscribe as a link, and must not be
 *   requested by the server when List-Unsubscribe-Post is absent. Hosts
 *   are classified with the WHATWG URL parser (Node's URL), so decimal,
 *   hex, octal, IPv4-mapped IPv6, and userinfo forms count as the host
 *   they actually navigate to.
 *
 * Not covered here:
 * - UnsubAgentSheet never reads `links`, so it does not navigate. The
 *   route it posts to is covered.
 * - A List-Unsubscribe-Post one-click value makes the server POST the
 *   header URL itself (perform in src/lib/mail/unsubscribe.ts). That sink
 *   is not this bug. This file only covers the fallthrough, when that
 *   POST does not succeed and the client would otherwise open the URL.
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Guide } from "../src/lib/inbox/types.ts";

process.env.SEER_DATA_DIR = "/tmp/seer-unsubscribe-redirect-tests";
for (const key of [
  "POSTGRES_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
]) {
  delete process.env[key];
}

const PLACEHOLDER_TOKEN = "test-access-token";
const PUBLIC_URL = "https://phish.example/login?next=inbox";
const PUBLIC_HTTP_URL = "http://phish.example/login?next=inbox";

const NON_PUBLIC_URLS = [
  "http://127.0.0.1/admin",
  "http://localhost/admin",
  "http://localhost./admin",
  "http://[::1]/admin",
  "http://[::]/admin",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.1.2.3/a",
  "http://192.168.0.5/a",
  "http://172.16.0.5/a",
  "http://0.0.0.0/a",
  "http://0/a",
  "http://2130706433/admin",
  "http://0x7f000001/admin",
  "http://127.1/admin",
  "http://0177.0.0.1/admin",
  "http://017700000001/admin",
  "https://phish.example@127.0.0.1/admin",
  "http://[::ffff:127.0.0.1]/admin",
  "http://[fd00::1]/admin",
  "http://[fe80::1]/admin",
  "https://10.1.2.3/x",
  "HTTP://LOCALHOST/admin",
  "http://127.0.0.1./admin",
];

function isNonPublicV4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function mappedV4(bare: string): number[] | null {
  const match = bare.match(/^::ffff:(.+)$/i);
  if (!match) return null;
  const rest = match[1];
  if (rest.includes(".")) {
    const parts = rest.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    return parts;
  }
  const groups = rest.split(":");
  const parse = (group: string) => Number.parseInt(group, 16);
  if (groups.length === 1) {
    const n = parse(groups[0]);
    if (!Number.isFinite(n)) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (groups.length === 2) {
    const hi = parse(groups[0]);
    const lo = parse(groups[1]);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255];
  }
  return null;
}

function isNonPublicV6(bare: string): boolean {
  const host = bare.toLowerCase();
  if (host === "::1" || host === "::") return true;
  const mapped = mappedV4(host);
  if (mapped) return isNonPublicV4(mapped);
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

/** True when a browser navigating `raw` would contact a non-public host. */
function hostIsNonPublic(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((part) => Number(part));
    if (octets.some((n) => n > 255)) return true;
    return isNonPublicV4(octets);
  }
  if (host.includes(":")) return isNonPublicV6(host);
  return false;
}

for (const url of NON_PUBLIC_URLS) {
  assert.equal(hostIsNonPublic(url), true, `classifier should refuse ${url}`);
}
assert.equal(hostIsNonPublic(PUBLIC_URL), false);
assert.equal(hostIsNonPublic(PUBLIC_HTTP_URL), false);
assert.equal(hostIsNonPublic("https://127.0.0.1.phish.example/login"), false);

type Script = {
  listUnsub: string;
  listUnsubPost?: string;
  /** Status for the server's one-click POST to the header URL. */
  oneClickStatus?: number;
  /** Header name as the provider returns it. */
  headerName?: string;
};

const scripts = new Map<string, Script>();
const calls: { method: string; url: string }[] = [];
const navigated: string[] = [];
let lastUnsubBody: Record<string, unknown> | null = null;
let lastUnsubRequest: Record<string, unknown> | null = null;

const session = {
  accessToken: PLACEHOLDER_TOKEN,
  provider: "google" as "google" | "microsoft-entra-id",
  email: "owner@example.com",
  name: "Owner",
  accountId: "acc-test",
};

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => session,
  },
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function firstHttp(listUnsub: string): string | undefined {
  for (const match of listUnsub.matchAll(/<([^>]+)>/g)) {
    const url = match[1].trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return undefined;
}

function messageIdFrom(url: string): string | undefined {
  const match = url.match(/\/messages\/([^/?]+)/);
  return match?.[1];
}

function gmailMessage(script: Script) {
  const headers = [
    {
      name: script.headerName ?? "List-Unsubscribe",
      value: script.listUnsub,
    },
  ];
  if (script.listUnsubPost) {
    headers.push({
      name: "List-Unsubscribe-Post",
      value: script.listUnsubPost,
    });
  }
  return { payload: { headers } };
}

function graphMessage(script: Script) {
  const internetMessageHeaders = [
    {
      name: script.headerName ?? "List-Unsubscribe",
      value: script.listUnsub,
    },
  ];
  if (script.listUnsubPost) {
    internetMessageHeaders.push({
      name: "List-Unsubscribe-Post",
      value: script.listUnsubPost,
    });
  }
  return { internetMessageHeaders };
}

function offeredUrls(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const urls: string[] = [];
  const links = body.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      if (link && typeof link === "object" && typeof (link as { url?: unknown }).url === "string") {
        urls.push((link as { url: string }).url);
      }
    }
  }
  if (typeof body.pendingUnsubscribeUrl === "string") urls.push(body.pendingUnsubscribeUrl);
  return urls;
}

let routePost: ((request: Request) => Promise<Response>) | null = null;
/** Message whose headers were just read. One-click runs against that message. */
let activeMessageId: string | undefined;

async function handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  calls.push({ method, url });

  if (url === "/api/unsubscribe" || url.endsWith("/api/unsubscribe")) {
    if (!routePost) throw new Error("unsubscribe route imported before the fetch handler was ready");
    const raw = typeof init?.body === "string" ? init.body : "";
    lastUnsubRequest = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const res = await routePost(
      new Request("http://inbox.test/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );
    lastUnsubBody = (await res.clone().json()) as Record<string, unknown>;
    return res;
  }

  if (url.startsWith("/api/")) {
    if (url.startsWith("/api/mailbox")) {
      return jsonResponse(200, {
        folder: "inbox",
        items: [],
        count: 0,
        accountEmail: "owner@example.com",
      });
    }
    if (url.startsWith("/api/today")) {
      return jsonResponse(200, {
        sections: [],
        needsReview: [],
        inbox: [],
        count: 0,
        accountEmail: "owner@example.com",
      });
    }
    if (url.startsWith("/api/accounts")) {
      return jsonResponse(200, {
        active: { email: "owner@example.com", name: "Owner", label: "Account" },
      });
    }
    if (url.startsWith("/api/catchup")) return jsonResponse(200, { quiet: true });
    return jsonResponse(200, { ok: true });
  }

  if (url.startsWith("https://gmail.googleapis.com/")) {
    if (url.includes("format=metadata")) {
      const id = messageIdFrom(url);
      const script = id ? scripts.get(id) : undefined;
      if (!script) return jsonResponse(404, { error: "not found" });
      activeMessageId = id;
      const auth = new Headers(init?.headers).get("authorization");
      assert.equal(auth, `Bearer ${PLACEHOLDER_TOKEN}`);
      return jsonResponse(200, gmailMessage(script));
    }
    return new Response("", { status: 200 });
  }

  if (url.startsWith("https://graph.microsoft.com/")) {
    if (url.includes("internetMessageHeaders")) {
      const id = messageIdFrom(url);
      const script = id ? scripts.get(id) : undefined;
      if (!script) return jsonResponse(404, { error: "not found" });
      activeMessageId = id;
      const auth = new Headers(init?.headers).get("authorization");
      assert.equal(auth, `Bearer ${PLACEHOLDER_TOKEN}`);
      return jsonResponse(200, graphMessage(script));
    }
    if (method === "GET") return jsonResponse(200, { value: [] });
    return new Response("", { status: 204 });
  }

  const active = activeMessageId ? scripts.get(activeMessageId) : undefined;
  if (active && method === "POST" && firstHttp(active.listUnsub) === url) {
    return new Response("no", { status: active.oneClickStatus ?? 500 });
  }

  return jsonResponse(599, { error: "blocked unexpected request" });
}

globalThis.fetch = handleFetch as typeof fetch;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://inbox.test/",
  pretendToBeVisual: true,
});
const { window } = dom;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globals, "navigator", {
  value: window.navigator,
  configurable: true,
});
globals.HTMLElement = window.HTMLElement;
globals.Element = window.Element;
globals.Node = window.Node;
globals.MouseEvent = window.MouseEvent;
globals.KeyboardEvent = window.KeyboardEvent;
globals.DOMParser = window.DOMParser;
globals.getComputedStyle = window.getComputedStyle.bind(window);
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
window.fetch = handleFetch as typeof fetch;

window.open = ((url?: string | URL) => {
  navigated.push(String(url));
  return null;
}) as typeof window.open;

(globalThis as unknown as { React: typeof React }).React = React;

const { POST } = await import("../src/app/api/unsubscribe/route.ts");
routePost = POST;
const { unsubscribeGmail, unsubscribeGraph } = await import("../src/lib/mail/unsubscribe.ts");
const { useMailbox } = await import("../src/lib/inbox/use-mailbox.ts");
const { ReaderMore } = await import("../src/components/inbox/ReaderMore.tsx");

type MailboxApi = {
  unsubscribe: (id: string, fromEmail?: string, threadId?: string) => Promise<void>;
  teachSender: (
    fromEmail: string,
    action: "unsubscribe",
    messageId?: string,
    threadId?: string,
  ) => Promise<void>;
  bulkSection: (
    section: {
      action: "unsubscribe";
      label: string;
      color: string;
      bulkLabel: string;
      items: Array<{
        id: string;
        threadId: string;
        fromEmail: string;
        fromName: string;
        subject: string;
        snippet: string;
        receivedAt: string;
        isUnread: boolean;
      }>;
    },
    action: "trash",
  ) => Promise<void>;
  toast: string | null;
  pendingUnsubscribeUrl?: string | null;
  confirmPendingUnsubscribe?: (url: string) => void | Promise<void>;
};

const guide: Guide = {
  action: "delete_now",
  label: "Delete",
  color: "#000",
  confidence: "HIGH",
  reason: "test",
  instruction: "test",
};

let latest: MailboxApi | null = null;
let root: Root | null = null;

function Screen() {
  const api = useMailbox("inbox") as unknown as MailboxApi;
  latest = api;
  return createElement(ReaderMore, {
    guide,
    onUnsubscribe: () => {
      void api.unsubscribe("msg-click", "attacker@lists.example", "thr-click");
    },
    onTeach: (action) => {
      if (action === "unsubscribe") {
        void api.teachSender("attacker@lists.example", "unsubscribe", "msg-teach", "thr-teach");
      }
    },
  });
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root?.render(createElement(Screen));
  });
  calls.length = 0;
  navigated.length = 0;
}

function resetTraffic() {
  calls.length = 0;
  navigated.length = 0;
  lastUnsubBody = null;
  lastUnsubRequest = null;
  activeMessageId = undefined;
}

function assertDidNotNavigate(label: string) {
  assert.deepEqual(
    navigated,
    [],
    `${label} navigated to ${JSON.stringify(navigated)} without a second confirmation`,
  );
  const href = window.location.href;
  let leftTheApp = false;
  try {
    const here = new URL(href);
    leftTheApp = here.origin !== "http://inbox.test" || hostIsNonPublic(href);
  } catch {
    leftTheApp = true;
  }
  assert.equal(leftTheApp, false, `${label} changed the page address to ${href}`);
}

function visibleUrl(api: MailboxApi): string {
  if (typeof api.pendingUnsubscribeUrl === "string" && api.pendingUnsubscribeUrl) {
    return api.pendingUnsubscribeUrl;
  }
  return api.toast ?? "";
}

async function confirmOnlyShownUrl(api: MailboxApi, shown: string) {
  assert.equal(
    typeof api.confirmPendingUnsubscribe,
    "function",
    "opening the unsubscribe address requires a second confirmation",
  );
  const confirm = api.confirmPendingUnsubscribe.bind(api);
  navigated.length = 0;
  await act(async () => {
    await confirm(shown);
  });
  assert.deepEqual(
    navigated,
    [shown],
    "confirmation must open only the exact address that was shown",
  );
  navigated.length = 0;
  await act(async () => {
    await confirm("https://other.example/steal");
  });
  assert.deepEqual(navigated, [], "confirmation of a different address must not navigate");
  navigated.length = 0;
  await act(async () => {
    await confirm("http://127.0.0.1/admin");
  });
  assert.deepEqual(navigated, [], "confirmation must not open a loopback address");
  navigated.length = 0;
  await act(async () => {
    await confirm("http://2130706433/admin");
  });
  assert.deepEqual(
    navigated,
    [],
    "confirmation must not open a decimal form of a loopback address",
  );
}

function assertNoServerHit(url: string) {
  const hits = calls.filter((call) => call.url === url);
  assert.deepEqual(hits, [], `server requested ${url} before refusing or showing it`);
}

async function flushClick(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  resetTraffic();
  session.provider = "google";
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}\n${message}`);
  }
}

await mount();

await check("menu click does not open a public List-Unsubscribe URL", async () => {
  scripts.set("msg-click", { listUnsub: `<${PUBLIC_URL}>` });
  const more = document.querySelector<HTMLElement>('[aria-label="More actions"]');
  assert.ok(more, "More actions button rendered");
  await flushClick(more);
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes("Unsubscribe"),
  );
  assert.ok(item, "Unsubscribe menu item rendered");
  await flushClick(item);
  assert.ok(
    calls.some(
      (call) =>
        call.url.includes("/messages/msg-click") && call.url.includes("List-Unsubscribe"),
    ),
    "click did not read List-Unsubscribe from the mailbox provider",
  );
  assert.ok(
    lastUnsubRequest && !JSON.stringify(lastUnsubRequest).includes("phish.example"),
    "the unsubscribe request must not be what supplies the target URL",
  );
  assert.ok(
    offeredUrls(lastUnsubBody).includes(PUBLIC_URL),
    `the exact header URL must stay visible to the client, got ${JSON.stringify(lastUnsubBody)}`,
  );
  assertNoServerHit(PUBLIC_URL);
  assertDidNotNavigate("Unsubscribe click");
  const api = latest;
  assert.ok(api);
  assert.ok(
    visibleUrl(api).includes(PUBLIC_URL),
    `the unsubscribe address must be shown before navigation, toast=${JSON.stringify(api.toast)} pending=${JSON.stringify(api.pendingUnsubscribeUrl)}`,
  );
  await confirmOnlyShownUrl(api, PUBLIC_URL);
});

await check("http List-Unsubscribe URL is not opened automatically", async () => {
  scripts.set("msg-http", { listUnsub: `<${PUBLIC_HTTP_URL}>` });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-http", "attacker@lists.example", "thr-http");
  });
  assert.ok(offeredUrls(lastUnsubBody).includes(PUBLIC_HTTP_URL));
  assertNoServerHit(PUBLIC_HTTP_URL);
  assertDidNotNavigate("http unsubscribe");
  assert.ok(visibleUrl(latest).includes(PUBLIC_HTTP_URL));
});

await check("Graph header URL is not opened from unsubscribe()", async () => {
  session.provider = "microsoft-entra-id";
  scripts.set("msg-graph", { listUnsub: `<${PUBLIC_URL}>` });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-graph", "attacker@lists.example", "thr-graph");
  });
  assert.ok(
    calls.some(
      (call) =>
        call.url.startsWith("https://graph.microsoft.com/") &&
        call.url.includes("/messages/msg-graph"),
    ),
    "Graph unsubscribe did not read the message headers",
  );
  assert.ok(offeredUrls(lastUnsubBody).includes(PUBLIC_URL));
  assertNoServerHit(PUBLIC_URL);
  assertDidNotNavigate("Graph unsubscribe");
  assert.ok(visibleUrl(latest).includes(PUBLIC_URL));
});

await check("teach Unsubscribe does not open the header URL", async () => {
  scripts.set("msg-teach", { listUnsub: `<${PUBLIC_URL}>` });
  const more = document.querySelector<HTMLElement>('[aria-label="More actions"]');
  assert.ok(more);
  await flushClick(more);
  const items = [...document.querySelectorAll('[role="menuitem"]')].filter((el) =>
    el.textContent?.includes("Unsubscribe"),
  );
  assert.ok(items.length >= 2, "teach menu should offer Unsubscribe");
  await flushClick(items[1]);
  assert.ok(
    calls.some((call) => call.url.includes("/messages/msg-teach")),
    "teach Unsubscribe did not read the message",
  );
  assertDidNotNavigate("teach Unsubscribe");
  assert.ok(latest && visibleUrl(latest).includes(PUBLIC_URL));
});

await check("failed one-click falls through without opening the URL", async () => {
  scripts.set("msg-fall", {
    listUnsub: "<https://phish.example/one-click-failed>",
    listUnsubPost: "List-Unsubscribe=One-Click",
    oneClickStatus: 500,
  });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-fall", "attacker@lists.example", "thr-fall");
  });
  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" && call.url === "https://phish.example/one-click-failed",
    ),
    "one-click attempt did not run",
  );
  assert.ok(offeredUrls(lastUnsubBody).includes("https://phish.example/one-click-failed"));
  assertDidNotNavigate("failed one-click");
  assert.ok(latest && visibleUrl(latest).includes("https://phish.example/one-click-failed"));
});

await check("successful one-click does not open a tab", async () => {
  scripts.set("msg-ok", {
    listUnsub: `<${PUBLIC_URL}>`,
    listUnsubPost: "List-Unsubscribe=One-Click",
    oneClickStatus: 200,
  });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-ok", "attacker@lists.example", "thr-ok");
  });
  assert.equal(lastUnsubBody?.oneClick, 1);
  assert.equal(offeredUrls(lastUnsubBody).length, 0);
  assertDidNotNavigate("successful one-click");
});

await check("mailto failure must not fall through into an automatic open", async () => {
  const url = "https://phish.example/after-mailto";
  scripts.set("msg-mailto", {
    listUnsub: `<mailto:not-an-email>, <${url}>`,
  });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-mailto", "attacker@lists.example", "thr-mailto");
  });
  assert.ok(offeredUrls(lastUnsubBody).includes(url), JSON.stringify(lastUnsubBody));
  assertNoServerHit(url);
  assertDidNotNavigate("mailto fallthrough");
  assert.ok(latest && visibleUrl(latest).includes(url));
});

await check("private URL ahead of a public one is not what gets opened", async () => {
  scripts.set("msg-mixed", {
    listUnsub: `<http://10.2.0.1/secret>, <${PUBLIC_URL}>`,
  });
  assert.ok(latest);
  await act(async () => {
    await latest?.unsubscribe("msg-mixed", "attacker@lists.example", "thr-mixed");
  });
  const offered = offeredUrls(lastUnsubBody);
  assert.ok(
    offered.every((url) => !hostIsNonPublic(url)),
    `non-public unsubscribe URL was offered: ${JSON.stringify(offered)}`,
  );
  assertDidNotNavigate("mixed unsubscribe");
  assertNoServerHit("http://10.2.0.1/secret");
  if (offered.includes(PUBLIC_URL)) {
    assert.ok(latest && visibleUrl(latest).includes(PUBLIC_URL));
  }
});

await check("bulk unsubscribe does not navigate and drops non-public links", async () => {
  scripts.set("msg-bulk", { listUnsub: "<http://192.168.1.20/router>" });
  assert.ok(latest);
  await act(async () => {
    await latest?.bulkSection(
      {
        action: "unsubscribe",
        label: "Unsubscribe",
        color: "#000",
        bulkLabel: "Unsubscribe",
        items: [
          {
            id: "msg-bulk",
            threadId: "thr-bulk",
            fromEmail: "attacker@lists.example",
            fromName: "Attacker",
            subject: "List",
            snippet: "",
            receivedAt: "2026-01-01T00:00:00.000Z",
            isUnread: true,
          },
        ],
      },
      "trash",
    );
  });
  assertDidNotNavigate("bulk unsubscribe");
  const offered = offeredUrls(lastUnsubBody);
  assert.ok(
    offered.every((url) => !hostIsNonPublic(url)),
    `bulk response offered a non-public URL: ${JSON.stringify(offered)}`,
  );
  assertNoServerHit("http://192.168.1.20/router");
});

let caseId = 0;
for (const url of NON_PUBLIC_URLS) {
  for (const provider of ["gmail", "graph"] as const) {
    const id = `direct-${caseId}`;
    caseId += 1;
    await check(`${provider} does not return ${url}`, async () => {
      scripts.set(id, { listUnsub: `<${url}>` });
      const result =
        provider === "gmail"
          ? await unsubscribeGmail(PLACEHOLDER_TOKEN, id)
          : await unsubscribeGraph(PLACEHOLDER_TOKEN, id);
      assert.notEqual(
        result.method,
        "link",
        `${provider} returned ${JSON.stringify(result)}`,
      );
      assertNoServerHit(url);
    });
  }
}

for (const url of NON_PUBLIC_URLS) {
  for (const provider of ["google", "microsoft-entra-id"] as const) {
    const id = `route-${caseId}`;
    caseId += 1;
    await check(`POST ${provider} does not link ${url}`, async () => {
      session.provider = provider;
      scripts.set(id, {
        listUnsub: `<${url}>`,
        headerName: url.includes("LOCALHOST") ? "list-unsubscribe" : undefined,
      });
      const res = await POST(
        new Request("http://inbox.test/api/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            threadId: `thr-${id}`,
            fromEmail: "attacker@lists.example",
          }),
        }),
      );
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200, JSON.stringify(body));
      const offered = offeredUrls(body);
      assert.ok(
        offered.every((item) => !hostIsNonPublic(item)),
        `route offered ${JSON.stringify(offered)}`,
      );
      assertNoServerHit(url);
    });
  }
}

await check("trimmed private List-Unsubscribe value is refused", async () => {
  const id = "route-trimmed";
  scripts.set(id, { listUnsub: "< http://192.168.1.50/admin >" });
  const result = await unsubscribeGmail(PLACEHOLDER_TOKEN, id);
  assert.notEqual(result.method, "link", JSON.stringify(result));
});

await check("lowercase Graph header name is still refused", async () => {
  const id = "route-lower";
  scripts.set(id, {
    listUnsub: "<http://172.20.0.4/admin>",
    headerName: "list-unsubscribe",
  });
  const result = await unsubscribeGraph(PLACEHOLDER_TOKEN, id);
  assert.notEqual(result.method, "link", JSON.stringify(result));
});

await root?.unmount();

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
}
console.log("unsubscribe-redirect: OK");
