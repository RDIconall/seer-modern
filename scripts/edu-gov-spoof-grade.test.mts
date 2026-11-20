/**
 * Spoofed school and government From addresses must not be graded as
 * trusted. These tests fail while a cold address is raised to respond
 * or read-and-archive because its domain ends in .edu or .gov.
 *
 * Safe outcome: the same cold-sender path as any other unknown address
 * (an ask is needs_review / cold-actionable-review; anything else is
 * read_and_delete / default-skim-delete). A sender the user has already
 * written is outside this spec.
 *
 * Routes that share this grader and are exercised here:
 * - GET /api/messages/[id] (gemini disabled, then the action guide)
 * - GET /api/mailbox and GET /api/today (provisional rules grade before
 *   any model read)
 * - GET /api/brief and GET /api/catchup (gemini disabled)
 * - GET /api/classifier/samples and the message-route rules fallback
 *   (classifyMessage directly)
 * - GET /api/alltasks and POST /api/cron/sync when the model does not
 *   grade the message (same rules fallback)
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "edu-gov-spoof-grade-"),
);

const { classifyMessage, ACTION_META } = await import(
  "../src/lib/inbox/classify.ts"
);
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideDetailed, buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { getGmailMessage, listGmailFolder } = await import(
  "../src/lib/mail/gmail.ts"
);
const { getGraphMessage } = await import("../src/lib/mail/graph.ts");

const ASK_SUBJECT = "Bursar hold";
const ASK_BODY = "Could you send the account number for the bursar hold?";
const NO_ASK_SUBJECT = "Campus notice";
const NO_ASK_BODY = "The office posted a new shelf list.";
const ACCOUNT = "owner@example.com";
const ACCESS_TOKEN = "test-access-token";

function history() {
  return {
    accountEmail: ACCOUNT,
    builtAt: "2026-11-20T00:00:00.000Z",
    contacts: {},
    engagedCount: 0,
    contactCount: 0,
  };
}

function coldAsk(fromEmail: string, fromName = "Office") {
  return classifyMessage(
    {
      fromEmail,
      fromName,
      subject: ASK_SUBJECT,
      snippet: ASK_BODY,
    },
    null,
    history(),
  );
}

function coldNote(fromEmail: string, fromName = "Office") {
  return classifyMessage(
    {
      fromEmail,
      fromName,
      subject: NO_ASK_SUBJECT,
      snippet: NO_ASK_BODY,
    },
    null,
    history(),
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
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

function installFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const body = handler(url, init);
    if (body === undefined) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Gmail payload shape read by getGmailMessage / hydrateOne. Auth headers are present and failing; the product never reads them. */
function gmailMessage(opts: {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
}) {
  return {
    id: opts.id,
    threadId: `thread-${opts.id}`,
    snippet: opts.snippet,
    internalDate: "1763630000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: opts.from },
        { name: "To", value: ACCOUNT },
        { name: "Subject", value: opts.subject },
        { name: "Message-ID", value: `<${opts.id}@spoof.example>` },
        {
          name: "Authentication-Results",
          value:
            "mx.google.com; spf=fail; dkim=fail; dmarc=fail header.from=university.edu",
        },
        { name: "Received-SPF", value: "fail" },
      ],
      body: { data: b64url(opts.body) },
    },
  };
}

async function gradeOpened(
  fromEmail: string,
  subject: string,
  body: string,
  fromName: string,
) {
  const bodyText =
    body ||
    "";
  return classifyInboxWithAssistant(
    ACCOUNT,
    [
      {
        id: `open-${fromEmail}`,
        fromEmail,
        fromName,
        subject,
        snippet: (bodyText || "").slice(0, 2000),
        threadId: `thread-open-${fromEmail}`,
        receivedAt: "2026-11-20T12:00:00.000Z",
      },
    ],
    history(),
    async () => null,
    classifyMessage,
    { geminiEnabled: false },
  );
}

console.log("edu/gov spoof grade");

await check(
  "a cold .edu ask is not told to reply",
  () => {
    const result = coldAsk("registrar@university.edu", "University Registrar");
    assert.equal(result.action, "needs_review");
    assert.equal(result.debug.ruleId, "cold-actionable-review");
    assert.equal(result.reason, coldAsk("registrar@university.example").reason);
  },
);

await check("a cold .EDU ask is graded the same after case folding", () => {
  const result = coldAsk("Registrar@University.EDU");
  assert.equal(result.action, "needs_review");
  assert.equal(result.debug.ruleId, "cold-actionable-review");
});

await check("a cold .edu subdomain ask is not told to reply", () => {
  const result = coldAsk("bursar@payments.university.edu", "Bursar");
  assert.equal(result.action, "needs_review");
  assert.equal(result.debug.ruleId, "cold-actionable-review");
});

await check("a cold .gov ask is not told to reply", () => {
  const result = coldAsk("clerk@state.treasury.gov", "County Clerk");
  assert.equal(result.action, "needs_review");
  assert.equal(result.debug.ruleId, "cold-actionable-review");
});

await check("a cold .edu notice is not kept as a school record", () => {
  const result = coldNote("registrar@university.edu");
  assert.equal(result.action, "read_and_delete");
  assert.equal(result.debug.ruleId, "default-skim-delete");
  assert.equal(
    result.action,
    coldNote("registrar@university.example").action,
  );
});

await check("a cold .gov notice is not kept as an agency record", () => {
  const result = coldNote("clerk@payments.agency.gov");
  assert.equal(result.action, "read_and_delete");
  assert.equal(result.debug.ruleId, "default-skim-delete");
});

await check(
  "a From value whose second @-piece ends in .edu is still a cold sender",
  () => {
    const result = coldAsk("bursar@university.edu@evil.example");
    assert.equal(result.action, "needs_review");
    assert.equal(result.debug.ruleId, "cold-actionable-review");
  },
);

await check(
  "opening a Gmail message with a failing DMARC .edu From shows the cold ask grade",
  async () => {
    const id = "gmail-edu-ask";
    const from = "University Registrar <registrar@university.edu>";
    const restore = installFetch((url) => {
      if (url === `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`) {
        return gmailMessage({
          id,
          from,
          subject: ASK_SUBJECT,
          snippet: "preview",
          body: ASK_BODY,
        });
      }
      return undefined;
    });
    try {
      const message = await getGmailMessage(ACCESS_TOKEN, id);
      assert.equal(message.fromEmail, "registrar@university.edu");
      const bodyText =
        message.textBody ||
        message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const decisions = await classifyInboxWithAssistant(
        ACCOUNT,
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
        history(),
        async () => null,
        classifyMessage,
        { geminiEnabled: false },
      );
      const classification = decisions.get(message.id);
      assert.ok(classification);
      assert.equal(classification.source, "rules");
      assert.equal(classification.action, "needs_review");
      assert.equal(classification.debug.ruleId, "rules:cold-actionable-review");
      const guide = await buildActionGuideDetailed(
        classification,
        message.subject,
        message.snippet,
        bodyText,
        message.fromName,
      );
      assert.equal(guide.action, "needs_review");
      assert.equal(guide.label, ACTION_META.needs_review.label);
      assert.equal(guide.category, "Everything else");
      assert.doesNotMatch(guide.harm, /waiting on you/);
      assert.doesNotMatch(guide.debug?.ruleId ?? "", /edu-gov/);
    } finally {
      restore();
    }
  },
);

await check(
  "opening a Graph message with a .gov From shows the cold ask grade",
  async () => {
    const id = "graph-gov-ask";
    const restore = installFetch((url) => {
      if (
        url ===
        `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=id,conversationId,subject,body,bodyPreview,receivedDateTime,isRead,from,toRecipients,ccRecipients,internetMessageId,hasAttachments`
      ) {
        return {
          id,
          conversationId: "conv-graph-gov",
          subject: ASK_SUBJECT,
          bodyPreview: "preview",
          body: { contentType: "text", content: ASK_BODY },
          receivedDateTime: "2026-11-20T12:00:00Z",
          isRead: false,
          from: {
            emailAddress: {
              name: "County Clerk",
              address: "clerk@state.treasury.gov",
            },
          },
          toRecipients: [{ emailAddress: { address: ACCOUNT } }],
          hasAttachments: false,
          internetMessageId: "<graph-gov-ask@spoof.example>",
        };
      }
      return undefined;
    });
    try {
      const message = await getGraphMessage(ACCESS_TOKEN, id);
      assert.equal(message.fromEmail, "clerk@state.treasury.gov");
      const bodyText =
        message.textBody ||
        message.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const decisions = await gradeOpened(
        message.fromEmail,
        message.subject,
        bodyText,
        message.fromName,
      );
      const classification = decisions.get(`open-${message.fromEmail}`);
      assert.ok(classification);
      assert.equal(classification.source, "rules");
      assert.equal(classification.action, "needs_review");
      assert.equal(classification.debug.ruleId, "rules:cold-actionable-review");
      const guide = await buildActionGuideDetailed(
        classification,
        message.subject,
        message.snippet,
        bodyText,
        message.fromName,
      );
      assert.equal(guide.label, "Needs your call");
      assert.equal(guide.category, "Everything else");
      assert.doesNotMatch(guide.harm, /waiting on you/);
    } finally {
      restore();
    }
  },
);

await check(
  "opening a Gmail .edu notice shows skim-and-delete, not keep",
  async () => {
    const id = "gmail-edu-note";
    const restore = installFetch((url) => {
      if (url.endsWith(`/messages/${id}?format=full`)) {
        return gmailMessage({
          id,
          from: "registrar@university.edu",
          subject: NO_ASK_SUBJECT,
          snippet: NO_ASK_BODY,
          body: NO_ASK_BODY,
        });
      }
      return undefined;
    });
    try {
      const message = await getGmailMessage(ACCESS_TOKEN, id);
      const decisions = await gradeOpened(
        message.fromEmail,
        message.subject,
        message.textBody,
        message.fromName,
      );
      const classification = decisions.get(`open-${message.fromEmail}`);
      assert.ok(classification);
      assert.equal(classification.action, "read_and_delete");
      assert.equal(classification.debug.ruleId, "rules:default-skim-delete");
      const guide = buildActionGuideQuick(
        classification,
        message.subject,
        message.fromName,
        message.snippet,
      );
      assert.equal(guide.action, "read_and_delete");
      assert.equal(guide.label, ACTION_META.read_and_delete.label);
      assert.equal(guide.category, "Everything else");
      assert.match(guide.instruction, /delete/i);
      assert.doesNotMatch(guide.instruction, /archive/i);
    } finally {
      restore();
    }
  },
);

await check(
  "the inbox list shows the cold grade before a deferred model read",
  async () => {
    const id = "list-edu-ask";
    const restore = installFetch((url) => {
      if (
        url.startsWith(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Ainbox&maxResults=",
        )
      ) {
        return { messages: [{ id, threadId: `thread-${id}` }] };
      }
      if (
        url ===
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc`
      ) {
        return gmailMessage({
          id,
          from: "University Registrar <registrar@university.edu>",
          subject: ASK_SUBJECT,
          snippet: ASK_BODY,
          body: ASK_BODY,
        });
      }
      return undefined;
    });
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    let deferred = false;
    try {
      const items = await listGmailFolder(ACCESS_TOKEN, "inbox", 40);
      assert.equal(items.length, 1);
      assert.equal(items[0].fromEmail, "registrar@university.edu");
      const decisions = await classifyInboxWithAssistant(
        "list-owner@example.com",
        items.map((m) => ({
          id: m.id,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          snippet: m.snippet,
          labelIds: m.labelIds,
          threadId: m.threadId,
          receivedAt: m.receivedAt,
        })),
        {
          ...history(),
          accountEmail: "list-owner@example.com",
        },
        async () => null,
        classifyMessage,
        {
          deferAi: true,
          onDeferred: () => {
            deferred = true;
          },
        },
      );
      const result = decisions.get(id);
      assert.ok(result);
      assert.equal(deferred, true);
      assert.equal(result.pending, true);
      assert.equal(result.source, "rules");
      assert.equal(result.action, "needs_review");
      assert.equal(result.debug.ruleId, "rules:cold-actionable-review");
      const guide = buildActionGuideQuick(
        result,
        items[0].subject,
        items[0].fromName,
        items[0].snippet,
      );
      assert.equal(guide.action, "needs_review");
      assert.equal(guide.label, "Needs your call");
      assert.equal(guide.category, "Everything else");
      assert.doesNotMatch(guide.harm, /waiting on you/);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
      restore();
    }
  },
);

await check(
  "a model-enabled grade with no model still leaves a cold .gov ask unraised",
  async () => {
    const decisions = await classifyInboxWithAssistant(
      "cron-owner@example.com",
      [
        {
          id: "cron-gov-ask",
          fromEmail: "clerk@payments.agency.gov",
          fromName: "Agency Clerk",
          subject: ASK_SUBJECT,
          snippet: ASK_BODY,
          threadId: "thread-cron-gov",
          receivedAt: "2026-11-20T12:00:00.000Z",
        },
      ],
      {
        ...history(),
        accountEmail: "cron-owner@example.com",
      },
      async () => null,
      classifyMessage,
      { geminiEnabled: true },
    );
    const result = decisions.get("cron-gov-ask");
    assert.ok(result);
    assert.equal(result.source, "rules");
    assert.equal(result.action, "needs_review");
    assert.equal(result.debug.ruleId, "rules:cold-actionable-review");
  },
);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
