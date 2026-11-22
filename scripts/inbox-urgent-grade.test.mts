/**
 * Spec for the open-message urgent grade.
 *
 * A message that was delivered with someone else's address in From, and
 * only "today" / "tomorrow" / "asap" / "eod" as urgency, must not be
 * graded Act today. These tests fail while that grade is still produced.
 *
 * The grading steps are the ones GET /api/messages/[id] runs
 * (src/app/api/messages/[id]/route.ts): provider parse, sent-folder
 * history, classifyInboxWithAssistant with the model disabled, then the
 * action guide. Brief, catch-up, the inbox list, today, all-tasks, and
 * the sync cron call that same grader.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "seer-urgent-grade-"),
);
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.POSTGRES_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideDetailed, buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { getOrBuildMailHistory } = await import(
  "../src/lib/inbox/mail-history-store.ts"
);
const { historySignals } = await import("../src/lib/inbox/mail-history.ts");
const { getGmailMessage, listGmailFolder, searchGmail } = await import(
  "../src/lib/mail/gmail.ts"
);
const { getGraphMessage, listGraphFolder } = await import(
  "../src/lib/mail/graph.ts"
);

type FetchHandler = (url: string) => unknown;

function installFetch(handler: FetchHandler) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = handler(url);
    return new Response(json == null ? "" : JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const ACCOUNT = "user@mailbox.test";
const CORRESPONDENT = "pat.lee@example.com";
const TOKEN = "placeholder-token";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

type Inbound = {
  id: string;
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  snippet?: string;
  /** When set, the Gmail payload carries this Authentication-Results value. */
  authenticationResults?: string;
};

function gmailFull(message: Inbound) {
  const headers: { name: string; value: string }[] = [
    {
      name: "From",
      value: message.from ?? `Pat Lee <${CORRESPONDENT}>`,
    },
    { name: "To", value: `User <${ACCOUNT}>` },
    { name: "Subject", value: message.subject },
    { name: "Message-ID", value: `<${message.id}@spoof.example>` },
  ];
  if (message.authenticationResults) {
    headers.push({
      name: "Authentication-Results",
      value: message.authenticationResults,
    });
  }
  const html = message.html;
  return {
    id: message.id,
    threadId: `thread-${message.id}`,
    snippet: message.snippet ?? "",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: html ? "text/html" : "text/plain",
      headers,
      body: { data: b64url(html ?? message.text ?? "") },
    },
  };
}

const FAILING_AUTH =
  "mx.google.com; dmarc=fail (p=none) header.from=example.com; spf=fail; dkim=fail";

function installGmail(sentDaysAgo: number, inbound: Inbound[]) {
  const byId = new Map(inbound.map((message) => [message.id, gmailFull(message)]));
  installFetch((url) => {
    if (url.includes("format=full")) {
      const id = inbound.find((message) => url.includes(`/messages/${message.id}?`))?.id;
      if (!id) throw new Error(`unexpected full fetch ${url}`);
      return byId.get(id);
    }
    if (url.includes("format=metadata") && url.includes("/messages/sent-1?")) {
      return {
        id: "sent-1",
        threadId: "thread-sent-1",
        snippet: "following up",
        internalDate: String(new Date(daysAgo(sentDaysAgo)).getTime()),
        labelIds: ["SENT"],
        payload: {
          headers: [
            { name: "From", value: `User <${ACCOUNT}>` },
            { name: "To", value: `Pat Lee <${CORRESPONDENT}>` },
            { name: "Subject", value: "following up" },
          ],
        },
      };
    }
    if (url.includes("q=in%3Asent") || url.includes("q=in:sent")) {
      return {
        messages: sentDaysAgo < 0 ? [] : [{ id: "sent-1", threadId: "thread-sent-1" }],
      };
    }
    return { messages: [] };
  });
}

async function gmailHistory(account: string, sentDaysAgo: number, inbound: Inbound[]) {
  installGmail(sentDaysAgo, inbound);
  return getOrBuildMailHistory(account, TOKEN, {
    listFolder: (token, folder, max) => listGmailFolder(token, folder, max),
    listArchive: (token, max) =>
      searchGmail(
        token,
        "-in:inbox -in:sent -in:trash -in:spam is:read",
        max,
      ),
  });
}

/**
 * Same grading the message route applies after it has loaded the message
 * and the sent-mail history. Model is off, as in that route.
 */
async function gradeOpened(
  account: string,
  history: Awaited<ReturnType<typeof gmailHistory>>,
  message: Awaited<ReturnType<typeof getGmailMessage>>,
) {
  const bodyText =
    message.textBody ||
    message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const decisions = await classifyInboxWithAssistant(
    account,
    [
      {
        id: message.id,
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: (bodyText || message.snippet).slice(0, 2000),
        labelIds: message.labelIds,
        threadId: message.threadId,
        receivedAt: message.receivedAt,
      },
    ],
    history,
    () => null,
    classifyMessage,
    { geminiEnabled: false },
  );
  const fromAssistant = decisions.get(message.id);
  const classification =
    fromAssistant ??
    ({
      ...classifyMessage(
        {
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: message.snippet,
        },
        null,
        history,
      ),
      source: "rules" as const,
    });
  const guide = await buildActionGuideDetailed(
    classification,
    message.subject,
    message.snippet,
    bodyText,
    message.fromName,
  );
  return { classification, guide };
}

function assertNotActToday(
  graded: {
    action: string;
    confidence: string;
    debug?: { ruleId?: string; relationship?: string };
    label?: string;
  },
  label: string,
) {
  const rule = graded.debug?.ruleId ?? "";
  assert.notEqual(
    graded.action,
    "act_today",
    `${label}: action=${graded.action} confidence=${graded.confidence} rule=${rule} relationship=${graded.debug?.relationship ?? ""} label=${graded.label ?? ""}`,
  );
  assert.equal(
    /engaged-schedule-today/.test(rule),
    false,
    `${label}: rule ${rule} still treats a day word as urgency`,
  );
  if (graded.label) {
    assert.notEqual(graded.label, "Act today", `${label}: guide label`);
  }
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

console.log("inbox urgent grade");

const freshInbound: Inbound[] = [
  {
    id: "in-today",
    subject: "today",
    authenticationResults: FAILING_AUTH,
  },
  { id: "in-tomorrow", subject: "tomorrow", authenticationResults: FAILING_AUTH },
  { id: "in-asap", subject: "ASAP", authenticationResults: FAILING_AUTH },
  { id: "in-eod", subject: "eod", authenticationResults: FAILING_AUTH },
  {
    id: "in-body",
    subject: "note",
    text: "Can we talk today",
    snippet: "no urgency in the preview",
    authenticationResults: FAILING_AUTH,
  },
  {
    id: "in-html",
    subject: "note",
    html: "<p>Need this <b>tomorrow</b></p>",
    snippet: "no urgency in the preview",
    authenticationResults: FAILING_AUTH,
  },
  {
    id: "in-preview",
    subject: "note",
    text: "",
    snippet: "wrapping up asap",
    authenticationResults: FAILING_AUTH,
  },
  {
    id: "in-no-auth-header",
    subject: "today",
    text: "status",
  },
  {
    id: "in-not-a-word",
    subject: "todayish checklist",
    text: "no separate day word",
    authenticationResults: FAILING_AUTH,
  },
  {
    id: "in-hold",
    subject: "Your appointment is scheduled for Tuesday at 9",
    text: "The technician will arrive then.",
    authenticationResults: FAILING_AUTH,
  },
];

const freshAccount = "fresh@mailbox.test";
const freshHistory = await gmailHistory(freshAccount, 2, freshInbound);

await check("sent mail makes the correspondent engaged before the message is graded", async () => {
  const stat = freshHistory.contacts[CORRESPONDENT];
  assert.ok(stat && stat.sentTo > 0, "sent folder did not record an outbound message");
  assert.equal(historySignals(freshHistory, CORRESPONDENT).relationship, "engaged");
  assert.equal(historySignals(freshHistory, CORRESPONDENT).staleEngagement, false);
});

async function openGmail(id: string) {
  installGmail(2, freshInbound);
  const message = await getGmailMessage(TOKEN, id);
  return gradeOpened(freshAccount, freshHistory, message);
}

await check("failing authentication is not on the parsed Gmail message", async () => {
  installGmail(2, freshInbound);
  const message = await getGmailMessage(TOKEN, "in-today");
  assert.equal(message.fromEmail, CORRESPONDENT);
  assert.equal(message.subject, "today");
  assert.equal(JSON.stringify(message).includes("dmarc"), false);
  assert.equal(JSON.stringify(message).includes("Authentication"), false);
});

for (const [id, word] of [
  ["in-today", "today"],
  ["in-tomorrow", "tomorrow"],
  ["in-asap", "asap"],
  ["in-eod", "eod"],
] as const) {
  await check(
    `open path: subject "${word}" from an unauthenticated engaged address is not Act today`,
    async () => {
      const { classification, guide } = await openGmail(id);
      assert.equal(classification.source, "rules");
      assertNotActToday(
        { ...classification, label: guide.label },
        `subject ${word}`,
      );
      installGmail(2, freshInbound);
      const message = await getGmailMessage(TOKEN, id);
      const direct = classifyMessage(
        {
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: message.snippet,
        },
        null,
        freshHistory,
      );
      assertNotActToday(direct, `classifyMessage subject ${word}`);
    },
  );
}

await check(
  "open path: day word only in the body is not Act today",
  async () => {
    const { classification, guide } = await openGmail("in-body");
    assert.equal(classification.source, "rules");
    assertNotActToday({ ...classification, label: guide.label }, "body today");
  },
);

await check(
  "open path: day word only in HTML is not Act today",
  async () => {
    const { classification, guide } = await openGmail("in-html");
    assert.equal(classification.source, "rules");
    assertNotActToday({ ...classification, label: guide.label }, "html tomorrow");
  },
);

await check(
  "open path: day word only in the preview is not Act today",
  async () => {
    const { classification, guide } = await openGmail("in-preview");
    assert.equal(classification.source, "rules");
    assertNotActToday({ ...classification, label: guide.label }, "preview asap");
    installGmail(2, freshInbound);
    const message = await getGmailMessage(TOKEN, "in-preview");
    const direct = classifyMessage(
      {
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: message.snippet,
      },
      null,
      freshHistory,
    );
    assertNotActToday(direct, "samples-route preview");
  },
);

await check(
  "open path: no Authentication-Results header is not treated as proof of the sender",
  async () => {
    const { classification, guide } = await openGmail("in-no-auth-header");
    assert.equal(classification.source, "rules");
    assertNotActToday(
      { ...classification, label: guide.label },
      "missing authentication",
    );
  },
);

await check(
  "a day word glued inside another word is not urgency",
  async () => {
    const { classification } = await openGmail("in-not-a-word");
    assert.notEqual(classification.action, "act_today");
  },
);

await check(
  "a confirmed appointment is still Act today",
  async () => {
    const { classification } = await openGmail("in-hold");
    assert.equal(classification.action, "act_today");
    assert.match(classification.debug.ruleId, /appointment-hold/);
  },
);

await check(
  "a stranger using the same day word is not Act today",
  async () => {
    const stranger = "cold@mailbox.test";
    const inbound: Inbound[] = [
      {
        id: "in-cold",
        from: "Stranger <nobody@cold.example>",
        subject: "today",
        authenticationResults: FAILING_AUTH,
      },
    ];
    const history = await gmailHistory(stranger, -1, inbound);
    installGmail(-1, inbound);
    const message = await getGmailMessage(TOKEN, "in-cold");
    assert.equal(message.fromEmail, "nobody@cold.example");
    assert.equal(historySignals(history, message.fromEmail).relationship, "cold");
    const { classification } = await gradeOpened(stranger, history, message);
    assert.notEqual(classification.action, "act_today");
  },
);

await check(
  "stale engagement still does not make asap Act today",
  async () => {
    const account = "stale@mailbox.test";
    const inbound: Inbound[] = [
      {
        id: "in-stale-asap",
        subject: "asap",
        authenticationResults: FAILING_AUTH,
      },
    ];
    const history = await gmailHistory(account, 45, inbound);
    assert.equal(historySignals(history, CORRESPONDENT).staleEngagement, true);
    installGmail(45, inbound);
    const message = await getGmailMessage(TOKEN, "in-stale-asap");
    const { classification, guide } = await gradeOpened(account, history, message);
    assertNotActToday({ ...classification, label: guide.label }, "stale asap");
  },
);

await check(
  "inbox list returns the same rules grade before any model call",
  async () => {
    installGmail(2, freshInbound);
    const message = await getGmailMessage(TOKEN, "in-today");
    const bodyText =
      message.textBody ||
      message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    let deferred = false;
    const decisions = await classifyInboxWithAssistant(
      freshAccount,
      [
        {
          id: message.id,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: (bodyText || message.snippet).slice(0, 2000),
          threadId: message.threadId,
          receivedAt: message.receivedAt,
        },
      ],
      freshHistory,
      () => null,
      classifyMessage,
      {
        deferAi: true,
        onDeferred: () => {
          deferred = true;
        },
      },
    );
    assert.equal(deferred, false);
    const result = decisions.get(message.id);
    assert.ok(result);
    assert.equal(result.source, "rules");
    const guide = buildActionGuideQuick(
      result,
      message.subject,
      message.fromName,
      message.snippet,
    );
    assertNotActToday({ ...result, label: guide.label }, "list provisional");
  },
);

await check(
  "sync grading with the model unavailable uses the same rules",
  async () => {
    installGmail(2, freshInbound);
    const message = await getGmailMessage(TOKEN, "in-eod");
    const decisions = await classifyInboxWithAssistant(
      freshAccount,
      [
        {
          id: message.id,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet: message.snippet,
          receivedAt: message.receivedAt,
        },
      ],
      freshHistory,
      () => null,
      classifyMessage,
      { geminiEnabled: true },
    );
    const result = decisions.get(message.id);
    assert.ok(result);
    assert.equal(result.source, "rules");
    assertNotActToday(result, "sync fallback");
  },
);

function installGraph(sentDaysAgo: number, inboundId: string, subject: string, preview: string) {
  installFetch((url) => {
    if (url.includes("/mailFolders/sentitems/")) {
      return {
        value: [
          {
            id: "graph-sent-1",
            conversationId: "graph-conv-sent",
            subject: "following up",
            bodyPreview: "following up",
            receivedDateTime: daysAgo(sentDaysAgo),
            sentDateTime: daysAgo(sentDaysAgo),
            isRead: true,
            from: { emailAddress: { name: "User", address: ACCOUNT } },
            toRecipients: [
              { emailAddress: { name: "Pat Lee", address: CORRESPONDENT } },
            ],
          },
        ],
      };
    }
    if (url.includes("/mailFolders/inbox/")) return { value: [] };
    if (url.includes(`/messages/${inboundId}`)) {
      return {
        id: inboundId,
        conversationId: `graph-conv-${inboundId}`,
        subject,
        bodyPreview: preview,
        body: { contentType: "text", content: preview },
        receivedDateTime: new Date().toISOString(),
        isRead: false,
        hasAttachments: false,
        from: { emailAddress: { name: "Pat Lee", address: CORRESPONDENT } },
        toRecipients: [{ emailAddress: { address: ACCOUNT } }],
        internetMessageHeaders: [
          { name: "Authentication-Results", value: FAILING_AUTH },
        ],
      };
    }
    throw new Error(`unexpected graph fetch ${url}`);
  });
}

await check(
  "Outlook open path: unauthenticated From plus today is not Act today",
  async () => {
    const account = "graph-today@mailbox.test";
    installGraph(2, "graph-today", "today", "status");
    const history = await getOrBuildMailHistory(account, TOKEN, {
      listFolder: (token, folder, max) => listGraphFolder(token, folder, max),
    });
    assert.ok((history.contacts[CORRESPONDENT]?.sentTo ?? 0) > 0);
    installGraph(2, "graph-today", "today", "status");
    const message = await getGraphMessage(TOKEN, "graph-today");
    assert.equal(message.fromEmail, CORRESPONDENT);
    assert.equal(JSON.stringify(message).includes("dmarc"), false);
    const { classification, guide } = await gradeOpened(account, history, message);
    assert.equal(classification.source, "rules");
    assertNotActToday({ ...classification, label: guide.label }, "graph today");
  },
);

await check(
  "Outlook open path: unauthenticated From plus eod is not Act today",
  async () => {
    const account = "graph-eod@mailbox.test";
    installGraph(2, "graph-eod", "eod", "status");
    const history = await getOrBuildMailHistory(account, TOKEN, {
      listFolder: (token, folder, max) => listGraphFolder(token, folder, max),
    });
    installGraph(2, "graph-eod", "eod", "status");
    const message = await getGraphMessage(TOKEN, "graph-eod");
    const { classification, guide } = await gradeOpened(account, history, message);
    assert.equal(classification.source, "rules");
    assertNotActToday({ ...classification, label: guide.label }, "graph eod");
  },
);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
