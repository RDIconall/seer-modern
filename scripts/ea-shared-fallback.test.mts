/**
 * A mailbox that has not saved an assistant must not be handed the deployment
 * address in SEER_EA_EMAIL. These tests fail while that fallback is in place:
 * delegate forwards the original sender, subject, and body there (and can
 * archive the thread), the settings endpoint reports that address as the
 * caller's own, clearing a saved assistant falls through to it again, and a
 * delegate draft with no recipient fills the same address in.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/ea-shared-fallback.test.mts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fsPromises } from "fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.SEER_USER_PROFILE;
delete process.env.VERCEL;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const DEPLOYMENT_EA = "owner-assistant@example.com";
const SAVED_EA = "mailbox-assistant@example.com";
const CHOSEN = "counsel@example.com";
const COLLEAGUE = "colleague@rditrials.com";
const OUTLOOK_COLLEAGUE = "outlook.colleague@rditrials.com";
const OUTSIDER = "stranger@gmail.com";
const ORIGINAL_FROM = "Pat Sender <pat.sender@example.com>";
const ORIGINAL_SUBJECT = "Confidential terms";
const ORIGINAL_BODY = "The body of the confidential message";
const PLACEHOLDER_TOKEN = "placeholder-access-token";

process.env.AUTH_SECRET = randomBytes(32).toString("base64");
process.env.SEER_DATA_DIR = await fsPromises.mkdtemp(path.join(os.tmpdir(), "seer-ea-"));
process.env.SEER_EA_EMAIL = DEPLOYMENT_EA;
process.env.SEER_EA_NAME = "Owner Assistant";
process.env.GEMINI_API_KEY = "placeholder";
process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";

const headerBag = new Headers();
const modelCalls: { prompt?: unknown; system?: unknown }[] = [];

mock.module("next/headers", {
  namedExports: {
    headers: async () => headerBag,
    cookies: async () => ({
      get(name: string) {
        const raw = headerBag.get("cookie") ?? "";
        for (const part of raw.split(";")) {
          const trimmed = part.trim();
          const eq = trimmed.indexOf("=");
          if (eq <= 0) continue;
          if (trimmed.slice(0, eq) === name) {
            return { name, value: trimmed.slice(eq + 1) };
          }
        }
        return undefined;
      },
    }),
  },
});

mock.module("ai", {
  namedExports: {
    Output: {
      object: () => ({ kind: "draft-schema" }),
    },
    generateText: async (args: { prompt?: unknown; system?: unknown }) => {
      modelCalls.push({ prompt: args.prompt, system: args.system });
      return { output: { body: "Please handle this." } };
    },
  },
});

const { encode } = await import("@auth/core/jwt");
const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccountWithCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { OWNER_EMAIL, isAllowedOrgEmail } = await import("../src/lib/auth/org.ts");
const { clearEa } = await import("../src/lib/store/ea.ts");
const eaRoute = await import("../src/app/api/ea/route.ts");
const delegateRoute = await import("../src/app/api/delegate/route.ts");
const draftRoute = await import("../src/app/api/assist/draft/route.ts");

const db = await startTestDb();

type Provider = "google" | "microsoft-entra-id";
type Call = { url: string; method: string; body?: string };

let calls: Call[] = [];
const originalFetch = globalThis.fetch;
const originalReadFile = fsPromises.readFile.bind(fsPromises);

function installFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body });
    if (url.includes("gmail.googleapis.com") && url.includes("format=full")) {
      return Response.json(gmailMessage());
    }
    if (url.includes("gmail.googleapis.com") && url.includes("/messages/send")) {
      return Response.json({ id: "sent-1", threadId: "thread-1" });
    }
    if (url.includes("gmail.googleapis.com") && url.includes("/modify")) {
      return Response.json({});
    }
    if (url.includes("graph.microsoft.com") && url.includes("/me/sendMail")) {
      return new Response(null, { status: 202 });
    }
    if (url.includes("graph.microsoft.com") && url.includes("/move")) {
      return Response.json({ id: "moved" });
    }
    if (url.includes("graph.microsoft.com") && url.includes("mailFolders")) {
      return Response.json({ value: [{ id: "archive-folder" }] });
    }
    if (url.includes("graph.microsoft.com") && url.includes("/me/messages/")) {
      return Response.json(graphMessage(OUTLOOK_COLLEAGUE));
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  }) as typeof fetch;
}

function gmailMessage() {
  return {
    id: "msg-1",
    threadId: "thread-1",
    snippet: ORIGINAL_BODY,
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: ORIGINAL_FROM },
        { name: "To", value: COLLEAGUE },
        { name: "Subject", value: ORIGINAL_SUBJECT },
        { name: "Message-ID", value: "<m@example.com>" },
      ],
      body: { data: Buffer.from(ORIGINAL_BODY, "utf8").toString("base64") },
    },
  };
}

function graphMessage(to: string) {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    subject: ORIGINAL_SUBJECT,
    bodyPreview: ORIGINAL_BODY,
    body: { contentType: "text", content: ORIGINAL_BODY },
    receivedDateTime: "2024-01-01T00:00:00.000Z",
    isRead: false,
    from: {
      emailAddress: { name: "Pat Sender", address: "pat.sender@example.com" },
    },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: [],
    internetMessageId: "<m@example.com>",
    hasAttachments: false,
  };
}

function gmailMime(): string | null {
  const send = calls.find((call) => call.url.includes("/messages/send"));
  if (!send?.body) return null;
  const raw = (JSON.parse(send.body) as { raw?: string }).raw;
  if (!raw) return null;
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

function gmailRecipient(): string | null {
  return gmailMime()?.match(/^To: (.+)$/m)?.[1]?.trim() ?? null;
}

function graphRecipient(): string | null {
  const send = calls.find((call) => call.url.includes("/me/sendMail"));
  if (!send?.body) return null;
  const parsed = JSON.parse(send.body) as {
    message?: {
      toRecipients?: { emailAddress?: { address?: string } }[];
      body?: { content?: string };
    };
  };
  return parsed.message?.toRecipients?.[0]?.emailAddress?.address ?? null;
}

function graphBody(): string {
  const send = calls.find((call) => call.url.includes("/me/sendMail"));
  if (!send?.body) return "";
  const parsed = JSON.parse(send.body) as {
    message?: { body?: { content?: string } };
  };
  return parsed.message?.body?.content ?? "";
}

function providerCalls(): Call[] {
  return calls.filter((call) =>
    /gmail\.googleapis\.com|graph\.microsoft\.com/.test(call.url),
  );
}

function archived(): boolean {
  return calls.some(
    (call) =>
      call.url.includes("/modify") ||
      call.url.includes("/move") ||
      call.url.includes("/trash") ||
      call.method === "DELETE",
  );
}

function describeSend(): string {
  const mime = gmailMime();
  const graphTo = graphRecipient();
  const parts = [
    `providerCalls=${providerCalls().length}`,
    `archived=${archived()}`,
    `modelCalls=${modelCalls.length}`,
  ];
  if (mime) {
    parts.push(
      `gmailTo=${gmailRecipient()}`,
      `gmailHasSender=${mime.includes("pat.sender@example.com")}`,
      `gmailHasSubject=${mime.includes(ORIGINAL_SUBJECT)}`,
      `gmailHasBody=${mime.includes(ORIGINAL_BODY)}`,
    );
  }
  if (graphTo) {
    const body = graphBody();
    parts.push(
      `graphTo=${graphTo}`,
      `graphHasSender=${body.includes("pat.sender@example.com")}`,
      `graphHasSubject=${body.includes(ORIGINAL_SUBJECT)}`,
      `graphHasBody=${body.includes(ORIGINAL_BODY)}`,
    );
  }
  return parts.join(" ");
}

async function signIn(email: string, provider: Provider) {
  const token = await encode({
    token: { email, name: email.split("@")[0], provider, sub: email },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  headerBag.set("cookie", `authjs.session-token=${token}`);
  headerBag.set("host", "127.0.0.1");
  headerBag.set("x-forwarded-proto", "http");
  headerBag.set("x-forwarded-host", "127.0.0.1");
}

function signOut() {
  headerBag.delete("cookie");
}

async function forgetEa(email: string) {
  await clearEa(email);
  const file = path.join(
    process.env.SEER_DATA_DIR!,
    `ea-${email.toLowerCase()}.json`,
  );
  await fsPromises.rm(file, { force: true });
}

function post(pathname: string, body: unknown) {
  return new Request(`http://127.0.0.1${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function saveAssistant(email: string, name: string) {
  const response = await eaRoute.POST(
    post("/api/ea", { email, name }),
  );
  const json = (await response.json()) as { ea?: { email?: string }; error?: string };
  assert.equal(response.status, 200, json.error ?? "saving an assistant failed");
  assert.equal(json.ea?.email, email);
}

let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  modelCalls.length = 0;
  installFetch();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    fsPromises.readFile = originalReadFile;
  }
}

async function seedAccount(
  email: string,
  provider: "google" | "microsoft",
) {
  const userId = await upsertUser(email);
  await upsertAccountWithCredentials({
    userId,
    provider,
    email,
    displayName: email.split("@")[0],
    accessToken: PLACEHOLDER_TOKEN,
    expiresAt: Date.now() + 86_400_000,
  });
}

await seedAccount(COLLEAGUE, "google");
await seedAccount(OUTLOOK_COLLEAGUE, "microsoft");
await seedAccount(OWNER_EMAIL, "google");

console.log("shared assistant fallback");

await check("an organization colleague is allowed to sign in", async () => {
  assert.equal(isAllowedOrgEmail(COLLEAGUE), true);
  assert.equal(isAllowedOrgEmail(OUTLOOK_COLLEAGUE), true);
  assert.equal(isAllowedOrgEmail(OWNER_EMAIL), true);
  assert.equal(isAllowedOrgEmail(OUTSIDER), false);
});

await check("a signed-out caller cannot delegate", async () => {
  signOut();
  const response = await delegateRoute.POST(post("/api/delegate", { id: "msg-1" }));
  assert.equal(response.status, 401);
  assert.equal(providerCalls().length, 0, describeSend());
});

await check("an address outside the organization cannot delegate", async () => {
  await signIn(OUTSIDER, "google");
  const response = await delegateRoute.POST(post("/api/delegate", { id: "msg-1" }));
  assert.equal(response.status, 401, describeSend());
  assert.equal(providerCalls().length, 0, describeSend());
});

await check(
  "a named recipient receives the forward and the deployment assistant does not",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1", to: CHOSEN }),
    );
    const json = (await response.json()) as { to?: string; error?: string };
    assert.equal(response.status, 200, json.error ?? describeSend());
    assert.equal(json.to, CHOSEN);
    const mime = gmailMime();
    assert.ok(mime, describeSend());
    assert.match(mime, new RegExp(`^To: ${CHOSEN}$`, "m"));
    assert.equal(mime.includes(DEPLOYMENT_EA), false, describeSend());
    assert.equal(mime.includes("pat.sender@example.com"), true, mime);
    assert.equal(mime.includes(ORIGINAL_SUBJECT), true, mime);
    assert.equal(mime.includes(ORIGINAL_BODY), true, mime);
    assert.equal(archived(), true, "a handoff the user addressed still archives");
  },
);

await check(
  "a colleague with no saved assistant is not shown the deployment address",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await eaRoute.GET();
    const json = (await response.json()) as {
      ea: { email?: string; name?: string } | null;
    };
    assert.equal(response.status, 200);
    assert.equal(
      json.ea,
      null,
      `settings returned ${json.ea?.email ?? "an assistant"} for a mailbox that saved none`,
    );
  },
);

await check(
  "the mailbox owner with no saved assistant is not shown the deployment address",
  async () => {
    await forgetEa(OWNER_EMAIL);
    await signIn(OWNER_EMAIL, "google");
    const response = await eaRoute.GET();
    const json = (await response.json()) as { ea: { email?: string } | null };
    assert.equal(response.status, 200);
    assert.equal(json.ea, null, `owner settings returned ${json.ea?.email}`);
  },
);

await check(
  "delegate without a recipient refuses and does not forward or archive",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    const json = (await response.json()) as { to?: string; needsEa?: boolean; error?: string };
    assert.equal(response.status, 412, describeSend());
    assert.equal(json.needsEa, true, JSON.stringify(json));
    assert.equal(json.to, undefined, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
    assert.equal(archived(), false, describeSend());
    assert.equal(gmailRecipient(), null, describeSend());
  },
);

await check(
  "a blank recipient is the same as omitting one",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1", to: "   " }),
    );
    assert.equal(response.status, 412, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
    assert.equal(archived(), false, describeSend());
  },
);

await check(
  "Outlook delegate without a recipient refuses and does not send or archive",
  async () => {
    await forgetEa(OUTLOOK_COLLEAGUE);
    await signIn(OUTLOOK_COLLEAGUE, "microsoft-entra-id");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    assert.equal(response.status, 412, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
    assert.equal(graphRecipient(), null, describeSend());
    assert.equal(archived(), false, describeSend());
  },
);

await check(
  "the owner cannot delegate through the deployment address either",
  async () => {
    await forgetEa(OWNER_EMAIL);
    await signIn(OWNER_EMAIL, "google");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    assert.equal(response.status, 412, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
    assert.notEqual(gmailRecipient(), DEPLOYMENT_EA, describeSend());
  },
);

await check(
  "another mailbox's saved assistant is not used for this colleague",
  async () => {
    await signIn(OWNER_EMAIL, "google");
    await saveAssistant("owner-saved@example.com", "Owner EA");
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const listed = await eaRoute.GET();
    const listedJson = (await listed.json()) as { ea: { email?: string } | null };
    assert.equal(listedJson.ea, null, `colleague was shown ${listedJson.ea?.email}`);
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    assert.equal(response.status, 412, describeSend());
    assert.notEqual(gmailRecipient(), "owner-saved@example.com", describeSend());
    assert.notEqual(gmailRecipient(), DEPLOYMENT_EA, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
  },
);

await check(
  "a saved assistant is who an unnamed handoff goes to",
  async () => {
    await signIn(COLLEAGUE, "google");
    await saveAssistant(SAVED_EA, "Casey");
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    const json = (await response.json()) as { to?: string; error?: string };
    assert.equal(response.status, 200, json.error ?? describeSend());
    assert.equal(json.to, SAVED_EA, describeSend());
    const mime = gmailMime();
    assert.ok(mime, describeSend());
    assert.match(mime, new RegExp(`^To: ${SAVED_EA}$`, "m"));
    assert.equal(mime.includes(DEPLOYMENT_EA), false, describeSend());
    assert.equal(mime.includes(ORIGINAL_BODY), true, mime);
    assert.equal(mime.includes("pat.sender@example.com"), true, mime);
    assert.equal(mime.includes(ORIGINAL_SUBJECT), true, mime);
  },
);

await check(
  "a saved assistant that disappears before a second lookup is not replaced",
  async () => {
    await signIn(COLLEAGUE, "google");
    await saveAssistant(SAVED_EA, "Casey");
    let reads = 0;
    const eaFile = `ea-${COLLEAGUE}`;
    fsPromises.readFile = (async (
      file: Parameters<typeof originalReadFile>[0],
      options?: Parameters<typeof originalReadFile>[1],
    ) => {
      if (String(file).includes(eaFile)) {
        reads += 1;
        if (reads > 1) {
          const missing = new Error("ENOENT") as NodeJS.ErrnoException;
          missing.code = "ENOENT";
          throw missing;
        }
      }
      return originalReadFile(file, options as never);
    }) as typeof fsPromises.readFile;
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    const json = (await response.json()) as { to?: string };
    const recipient = gmailRecipient();
    assert.notEqual(recipient, DEPLOYMENT_EA, describeSend());
    assert.notEqual(json.to, DEPLOYMENT_EA, describeSend());
    if (response.status === 200) {
      assert.equal(json.to, SAVED_EA, `${describeSend()} reads=${reads}`);
      assert.equal(recipient, SAVED_EA, describeSend());
      const mime = gmailMime();
      assert.equal(mime?.includes(ORIGINAL_BODY), true, mime ?? "");
    } else {
      assert.equal(response.status, 412, describeSend());
      assert.equal(providerCalls().length, 0, describeSend());
      assert.equal(archived(), false, describeSend());
    }
    assert.ok(reads >= 1, "the assistant record was never read");
  },
);

await check(
  "clearing a saved assistant does not restore the deployment address",
  async () => {
    await signIn(COLLEAGUE, "google");
    await saveAssistant(SAVED_EA, "Casey");
    const cleared = await eaRoute.POST(post("/api/ea", { clear: true }));
    const clearedJson = (await cleared.json()) as { ea: { email?: string } | null };
    assert.equal(cleared.status, 200);
    assert.equal(clearedJson.ea, null);
    const listed = await eaRoute.GET();
    const listedJson = (await listed.json()) as { ea: { email?: string } | null };
    assert.equal(
      listedJson.ea,
      null,
      `after clear, settings returned ${listedJson.ea?.email}`,
    );
    const response = await delegateRoute.POST(
      post("/api/delegate", { id: "msg-1" }),
    );
    assert.equal(response.status, 412, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
    assert.equal(archived(), false, describeSend());
  },
);

await check(
  "with no deployment address, an unnamed handoff already refuses",
  async () => {
    const previous = process.env.SEER_EA_EMAIL;
    const previousName = process.env.SEER_EA_NAME;
    delete process.env.SEER_EA_EMAIL;
    delete process.env.SEER_EA_NAME;
    try {
      await forgetEa(COLLEAGUE);
      await signIn(COLLEAGUE, "google");
      const response = await delegateRoute.POST(
        post("/api/delegate", { id: "msg-1" }),
      );
      assert.equal(response.status, 412, describeSend());
      assert.equal(providerCalls().length, 0, describeSend());
    } finally {
      process.env.SEER_EA_EMAIL = previous;
      process.env.SEER_EA_NAME = previousName;
    }
  },
);

await check(
  "a delegate draft with no recipient refuses before reading or drafting the message",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await draftRoute.POST(
      post("/api/assist/draft", { id: "msg-1", intent: "delegate" }),
    );
    const json = (await response.json()) as { to?: string; error?: string; needsEa?: boolean };
    assert.equal(response.status, 412, `${JSON.stringify(json)} ${describeSend()}`);
    assert.equal(json.needsEa, true, JSON.stringify(json));
    assert.notEqual(json.to, DEPLOYMENT_EA, JSON.stringify(json));
    assert.equal(modelCalls.length, 0, "the draft model saw the message before the handoff was refused");
    assert.equal(providerCalls().length, 0, describeSend());
  },
);

await check(
  "a delegate draft with a blank recipient refuses the same way",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await draftRoute.POST(
      post("/api/assist/draft", { id: "msg-1", intent: "delegate", to: "  " }),
    );
    const json = (await response.json()) as { to?: string };
    assert.equal(response.status, 412, `${JSON.stringify(json)} ${describeSend()}`);
    assert.notEqual(json.to, DEPLOYMENT_EA, JSON.stringify(json));
    assert.equal(modelCalls.length, 0, describeSend());
    assert.equal(providerCalls().length, 0, describeSend());
  },
);

await check(
  "a delegate draft with no recipient uses the mailbox's saved assistant",
  async () => {
    await signIn(COLLEAGUE, "google");
    await saveAssistant(SAVED_EA, "Casey");
    const response = await draftRoute.POST(
      post("/api/assist/draft", { id: "msg-1", intent: "delegate" }),
    );
    const json = (await response.json()) as {
      to?: string;
      subject?: string;
      mode?: string;
      error?: string;
    };
    assert.equal(response.status, 200, json.error ?? JSON.stringify(json));
    assert.equal(json.to, SAVED_EA, JSON.stringify(json));
    assert.notEqual(json.to, DEPLOYMENT_EA, JSON.stringify(json));
    assert.equal(json.mode, "forward");
    assert.equal(json.subject, `Fwd: ${ORIGINAL_SUBJECT}`);
    assert.equal(modelCalls.length, 1, "the handoff note was not drafted");
    const prompt = JSON.stringify(modelCalls[0]?.prompt ?? "");
    assert.equal(prompt.includes(ORIGINAL_BODY), true, prompt);
    assert.equal(prompt.includes("pat.sender@example.com"), true, prompt);
    assert.equal(prompt.includes(ORIGINAL_SUBJECT), true, prompt);
  },
);

await check(
  "a delegate draft addressed by the caller keeps that recipient",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await draftRoute.POST(
      post("/api/assist/draft", {
        id: "msg-1",
        intent: "delegate",
        to: CHOSEN,
        toName: "Counsel",
      }),
    );
    const json = (await response.json()) as { to?: string; error?: string };
    assert.equal(response.status, 200, json.error ?? JSON.stringify(json));
    assert.equal(json.to, CHOSEN, JSON.stringify(json));
    assert.notEqual(json.to, DEPLOYMENT_EA, JSON.stringify(json));
  },
);

await check(
  "an ordinary reply is not redirected to an assistant",
  async () => {
    await forgetEa(COLLEAGUE);
    await signIn(COLLEAGUE, "google");
    const response = await draftRoute.POST(
      post("/api/assist/draft", { id: "msg-1", intent: "yes" }),
    );
    const json = (await response.json()) as { to?: string; mode?: string; error?: string };
    assert.equal(response.status, 200, json.error ?? JSON.stringify(json));
    assert.equal(json.to, "pat.sender@example.com", JSON.stringify(json));
    assert.equal(json.mode, "reply");
    assert.notEqual(json.to, DEPLOYMENT_EA, JSON.stringify(json));
  },
);

await check(
  "a saved assistant that disappears before the draft is addressed is not replaced",
  async () => {
    await signIn(COLLEAGUE, "google");
    await saveAssistant(SAVED_EA, "Casey");
    let reads = 0;
    const eaFile = `ea-${COLLEAGUE}`;
    fsPromises.readFile = (async (
      file: Parameters<typeof originalReadFile>[0],
      options?: Parameters<typeof originalReadFile>[1],
    ) => {
      if (String(file).includes(eaFile)) {
        reads += 1;
        if (reads > 1) {
          const missing = new Error("ENOENT") as NodeJS.ErrnoException;
          missing.code = "ENOENT";
          throw missing;
        }
      }
      return originalReadFile(file, options as never);
    }) as typeof fsPromises.readFile;
    const response = await draftRoute.POST(
      post("/api/assist/draft", { id: "msg-1", intent: "delegate" }),
    );
    const json = (await response.json()) as { to?: string; error?: string };
    assert.notEqual(json.to, DEPLOYMENT_EA, `${JSON.stringify(json)} reads=${reads} ${describeSend()}`);
    if (response.status === 200) {
      assert.equal(json.to, SAVED_EA, `${JSON.stringify(json)} reads=${reads}`);
    } else {
      assert.equal(response.status, 412, JSON.stringify(json));
      assert.equal(modelCalls.length, 0, describeSend());
      assert.equal(providerCalls().length, 0, describeSend());
    }
  },
);

globalThis.fetch = originalFetch;
fsPromises.readFile = originalReadFile;
await fsPromises.rm(process.env.SEER_DATA_DIR, { recursive: true, force: true });
await db.stop();

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
