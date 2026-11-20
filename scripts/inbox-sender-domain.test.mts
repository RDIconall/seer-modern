/**
 * Spec for unanchored sender-class lists in the legacy inbox grader.
 *
 * These tests fail while a listed fragment in a display name, or a
 * fragment that merely occurs inside a different domain, is enough to
 * grade the message as product, shopping, or finance mail. They pass
 * once sender class is decided only from the address's own domain,
 * anchored at a dot boundary and the end of that domain.
 *
 * The cases call the same functions the product calls:
 *   - Gmail From parsing (open + inbox list)
 *   - Graph display-name mapping (open + inbox list)
 *   - classifyInboxWithAssistant with the model turned off
 *     (message open, brief rebuild, catch-up)
 *   - the same assistant with the model configured but deferred
 *     (mailbox and today return the rules grade immediately)
 *   - classifyMessage, the rules function those routes pass in
 *   - buildActionGuideQuick / buildActionGuideDetailed, which attach
 *     the sender story the owner reads before a bulk clear
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-domain-"));
for (const key of [
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "OPENAI_API_KEY",
]) {
  delete process.env[key];
}

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { buildActionGuideDetailed, buildActionGuideQuick } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { getGmailMessage, listGmailFolder } = await import(
  "../src/lib/mail/gmail.ts"
);
const { getGraphMessage, listGraphFolder } = await import(
  "../src/lib/mail/graph.ts"
);
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");

type Grade = {
  action: string;
  ruleId: string;
  reason: string;
  source?: string;
  who?: string;
  category?: string;
  label: string;
  instruction: string;
  bulk: string;
};

const OWNER = "owner@mailbox.test";
const TOKEN = "placeholder-token";

let failures = 0;

function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.stack ?? e.message : e}`,
      );
    });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function gradeWithRules(
  input: {
    id: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    snippet: string;
    threadId?: string;
  },
  extras?: { deferAi?: boolean },
): Promise<{ grade: Grade; scheduledModel: boolean }> {
  let scheduledModel = false;
  const decisions = await classifyInboxWithAssistant(
    OWNER,
    [
      {
        id: input.id,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        subject: input.subject,
        snippet: input.snippet,
        threadId: input.threadId ?? `thread-${input.id}`,
        receivedAt: new Date().toISOString(),
      },
    ],
    null,
    async () => null,
    classifyMessage,
    {
      geminiEnabled: extras?.deferAi ? undefined : false,
      deferAi: extras?.deferAi,
      onDeferred: extras?.deferAi
        ? () => {
            scheduledModel = true;
          }
        : undefined,
    },
  );
  const result = decisions.get(input.id);
  assert.ok(result, "grader returned no decision");
  const guide = buildActionGuideQuick(
    result,
    input.subject,
    input.fromName,
    input.snippet,
  );
  return {
    scheduledModel,
    grade: {
      action: result.action,
      ruleId: result.debug.ruleId,
      reason: result.reason,
      source: result.source,
      who: guide.who,
      category: guide.category,
      label: guide.label,
      instruction: guide.instruction,
      bulk: primaryMailAction(result.action),
    },
  };
}

/** A stranger with no listed domain is skim-then-delete, not a company robot. */
function assertOrdinaryMail(grade: Grade) {
  assert.equal(grade.source, "rules");
  assert.equal(grade.action, "read_and_delete");
  assert.match(grade.ruleId, /default-skim-delete/);
  assert.equal(grade.label, "Read and delete");
  assert.equal(grade.category, "Everything else");
  assert.doesNotMatch(grade.ruleId, /product|shopping|finance|marketing/);
  assert.doesNotMatch(
    grade.who ?? "",
    /product\/service notification|store's marketing list|bank\/payments\/billing/,
  );
  assert.doesNotMatch(grade.instruction, /Safe to delete without opening/);
  assert.notEqual(grade.label, "Don't read — delete");
  assert.notEqual(grade.label, "Act today");
}

function directRule(input: {
  fromEmail: string;
  fromName?: string;
  subject: string;
  snippet: string;
}) {
  return classifyMessage(input, null, null);
}

const PASSIVE = {
  subject: "Build passed on main",
  snippet: "The workflow finished cleanly.",
};
const SIGN_IN = {
  subject: "New sign-in to your account",
  snippet: "A new sign-in was recorded.",
};
const MENTION = {
  subject: "Alex mentioned you in the design doc",
  snippet: "There is a note on the latest mock.",
};
const NOTE = {
  subject: "Hello from the desk",
  snippet: "A short note with nothing attached.",
};

await check(
  "gmail open: display name containing github.com is not a product security alert",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      assert.match(u, /gmail\.googleapis\.com/);
      assert.match(u, /\/users\/me\/messages\/msg-signin/);
      return jsonResponse({
        id: "msg-signin",
        threadId: "thr-signin",
        snippet: SIGN_IN.snippet,
        internalDate: String(Date.now()),
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "From",
              value: '"GitHub Security github.com" <alex@evil.example>',
            },
            { name: "Subject", value: SIGN_IN.subject },
            { name: "To", value: OWNER },
          ],
          body: {
            data: Buffer.from(SIGN_IN.snippet, "utf8").toString("base64url"),
          },
        },
      });
    };
    try {
      const message = await getGmailMessage(TOKEN, "msg-signin");
      assert.equal(message.fromEmail, "alex@evil.example");
      assert.match(message.fromName, /github\.com/i);

      const { grade } = await gradeWithRules({
        id: message.id,
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: message.snippet,
        threadId: message.threadId,
      });
      assertOrdinaryMail(grade);

      const direct = directRule({
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: message.snippet,
      });
      assert.equal(direct.action, "read_and_delete");
      assert.match(direct.debug.ruleId, /default-skim-delete/);

      const detailed = await buildActionGuideDetailed(
        { ...direct, source: "rules" },
        message.subject,
        message.snippet,
        message.textBody,
        message.fromName,
      );
      assert.equal(detailed.action, "read_and_delete");
      assert.doesNotMatch(
        detailed.who ?? "",
        /product\/service notification/,
      );
      assert.notEqual(detailed.category, "Product updates");
    } finally {
      globalThis.fetch = original;
    }
  },
);

await check(
  "gmail inbox list: inbox.com is not box.com or x.com, so a passive note is not delete-now",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      assert.match(u, /gmail\.googleapis\.com/);
      if (u.includes("format=metadata")) {
        return jsonResponse({
          id: "msg-inbox",
          threadId: "thr-inbox",
          snippet: PASSIVE.snippet,
          internalDate: String(Date.now()),
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            headers: [
              { name: "From", value: "Alex <alex@inbox.com>" },
              { name: "Subject", value: PASSIVE.subject },
              { name: "To", value: OWNER },
            ],
          },
        });
      }
      return jsonResponse({
        messages: [{ id: "msg-inbox", threadId: "thr-inbox" }],
      });
    };
    try {
      const [item] = await listGmailFolder(TOKEN, "inbox", 5);
      assert.equal(item.fromEmail, "alex@inbox.com");
      assert.equal(item.subject, PASSIVE.subject);

      const { grade } = await gradeWithRules({
        id: item.id,
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
        threadId: item.threadId,
      });
      assertOrdinaryMail(grade);
      assert.notEqual(grade.action, "delete_now");
    } finally {
      globalThis.fetch = original;
    }
  },
);

await check(
  "graph inbox list: a honey.com display name on another domain is not shopping mail",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      assert.match(u, /graph\.microsoft\.com/);
      return jsonResponse({
        value: [
          {
            id: "msg-honey",
            conversationId: "thr-honey",
            subject: "Weekend notes",
            bodyPreview: "A few links for later.",
            receivedDateTime: new Date().toISOString(),
            isRead: false,
            from: {
              emailAddress: {
                name: "Honey savings honey.com",
                address: "alex@evil.example",
              },
            },
          },
        ],
      });
    };
    try {
      const [item] = await listGraphFolder(TOKEN, "inbox", 5);
      assert.equal(item.fromEmail, "alex@evil.example");
      assert.match(item.fromName, /honey\.com/i);
      const { grade } = await gradeWithRules({
        id: item.id,
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
        threadId: item.threadId,
      });
      assertOrdinaryMail(grade);
      assert.doesNotMatch(grade.who ?? "", /store's marketing list/);
    } finally {
      globalThis.fetch = original;
    }
  },
);

await check(
  "graph open: a slack.com display name plus 'mentioned you' is not act-today",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      assert.match(u, /graph\.microsoft\.com/);
      assert.match(u, /\/me\/messages\/msg-slack/);
      return jsonResponse({
        id: "msg-slack",
        conversationId: "thr-slack",
        subject: MENTION.subject,
        bodyPreview: MENTION.snippet,
        body: { contentType: "text", content: MENTION.snippet },
        receivedDateTime: new Date().toISOString(),
        isRead: false,
        from: {
          emailAddress: {
            name: "Slack slack.com",
            address: "alex@evil.example",
          },
        },
      });
    };
    try {
      const message = await getGraphMessage(TOKEN, "msg-slack");
      assert.equal(message.fromEmail, "alex@evil.example");
      assert.match(message.fromName, /slack\.com/i);
      const { grade } = await gradeWithRules({
        id: message.id,
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        subject: message.subject,
        snippet: message.snippet,
        threadId: message.threadId,
      });
      assertOrdinaryMail(grade);

      const detailed = await buildActionGuideDetailed(
        classifyMessage(
          {
            fromEmail: message.fromEmail,
            fromName: message.fromName,
            subject: message.subject,
            snippet: message.snippet,
          },
          null,
          null,
        ),
        message.subject,
        message.snippet,
        message.textBody,
        message.fromName,
      );
      assert.notEqual(detailed.action, "act_today");
      assert.notEqual(detailed.category, "Product updates");
    } finally {
      globalThis.fetch = original;
    }
  },
);

await check(
  "mailbox/today defer the model and still must not keep a forged product grade",
  async () => {
    process.env.GEMINI_API_KEY = "placeholder";
    try {
      const { grade, scheduledModel } = await gradeWithRules(
        {
          id: "msg-deferred",
          fromEmail: "alex@evil.example",
          fromName: "GitHub Security github.com",
          ...SIGN_IN,
        },
        { deferAi: true },
      );
      assert.equal(scheduledModel, true);
      assertOrdinaryMail(grade);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  },
);

await check(
  "domains that only contain a listed fragment are ordinary mail",
  async () => {
    const cases = [
      {
        fromEmail: "alex@notgithub.com",
        fromName: "Alex",
        ...SIGN_IN,
      },
      {
        fromEmail: "alex@github.com.evil.example",
        fromName: "Alex",
        ...SIGN_IN,
      },
      {
        fromEmail: "alex@mybox.com",
        fromName: "Alex",
        ...PASSIVE,
      },
      {
        fromEmail: "alex@notjira.example",
        fromName: "Alex",
        ...PASSIVE,
      },
      {
        fromEmail: "alex@notahoney.example",
        fromName: "Alex",
        subject: "Weekend notes",
        snippet: "A few links for later.",
      },
      {
        fromEmail: "alex@honey.evil.example",
        fromName: "Alex",
        subject: "Weekend notes",
        snippet: "A few links for later.",
      },
      {
        fromEmail: "alex@namexample.com",
        fromName: "Alex",
        ...NOTE,
      },
      {
        fromEmail: "alex@chase.com.evil.example",
        fromName: "Alex",
        ...NOTE,
      },
    ];
    for (const input of cases) {
      const { grade } = await gradeWithRules({ id: input.fromEmail, ...input });
      assertOrdinaryMail(grade);
      const direct = directRule(input);
      assert.equal(direct.action, "read_and_delete", input.fromEmail);
      assert.match(direct.debug.ruleId, /default-skim-delete/);
    }
  },
);

await check(
  "amex.com is a finance sender, not a product sender via the x.com fragment",
  async () => {
    const input = {
      id: "amex",
      fromEmail: "alex@amex.com",
      fromName: "Alex",
      ...NOTE,
    };
    const { grade } = await gradeWithRules(input);
    assert.equal(grade.action, "read_and_archive");
    assert.match(grade.ruleId, /finance-record-archive/);
    assert.doesNotMatch(grade.ruleId, /product/);
    assert.match(grade.who ?? "", /bank\/payments\/billing/);
    assert.equal(grade.category, "Money & bills");
    assert.equal(grade.bulk, "archive");
    const direct = directRule(input);
    assert.equal(direct.action, "read_and_archive");
    assert.equal(direct.debug.ruleId, "finance-record-archive");
  },
);

await check(
  "a real company domain is still classified from the address",
  async () => {
    const productUrgent = await gradeWithRules({
      id: "gh-urgent",
      fromEmail: "alerts@github.com",
      fromName: "GitHub",
      ...SIGN_IN,
    });
    assert.equal(productUrgent.grade.action, "act_today");
    assert.match(productUrgent.grade.ruleId, /product-needs-you/);
    assert.equal(productUrgent.grade.bulk, "read");

    const productSub = await gradeWithRules({
      id: "gh-sub",
      fromEmail: "ci@notify.github.com",
      fromName: "GitHub",
      ...PASSIVE,
    });
    assert.equal(productSub.grade.action, "delete_now");
    assert.match(productSub.grade.ruleId, /product-passive-delete/);
    assert.equal(productSub.grade.bulk, "trash");

    const box = directRule({
      fromEmail: "alex@box.com",
      fromName: "Box",
      ...PASSIVE,
    });
    assert.equal(box.action, "delete_now");
    assert.equal(box.debug.ruleId, "product-passive-delete");

    const atlassian = directRule({
      fromEmail: "bot@acme.atlassian.net",
      fromName: "Jira",
      ...PASSIVE,
    });
    assert.equal(atlassian.action, "delete_now");
    assert.equal(atlassian.debug.ruleId, "product-passive-delete");

    const honey = await gradeWithRules({
      id: "honey",
      fromEmail: "alex@shop.honey.com",
      fromName: "Honey",
      subject: "Weekend notes",
      snippet: "A few links for later.",
    });
    assert.equal(honey.grade.action, "delete_now");
    assert.match(honey.grade.ruleId, /shopping-domain/);
    assert.match(honey.grade.who ?? "", /store's marketing list/);
    assert.equal(honey.grade.category, "Shopping & promos");

    const amex = directRule({
      fromEmail: "alex@email.americanexpress.com",
      fromName: "American Express",
      ...NOTE,
    });
    assert.equal(amex.action, "read_and_archive");
    assert.equal(amex.debug.ruleId, "finance-record-archive");
  },
);

await check(
  "security-alert wording stays urgent from any sender, without a product rule",
  async () => {
    const { grade } = await gradeWithRules({
      id: "alert",
      fromEmail: "alex@evil.example",
      fromName: "GitHub Security github.com",
      subject: "Security alert",
      snippet: "We noticed a security alert on the account.",
    });
    assert.equal(grade.action, "act_today");
    assert.match(grade.ruleId, /transactional-urgent/);
    assert.doesNotMatch(grade.ruleId, /product/);
  },
);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
