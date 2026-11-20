/**
 * Spec for the unconfirmed-sender delete bypass.
 *
 * These tests fail while inbox grading still treats one model reading of
 * attacker-written mail as a person in the user's life. They pass once a
 * delete, unsubscribe, read-and-delete, or glance decision is left alone
 * unless the address was earned by sent mail, a saved contact, or a meeting,
 * and a single model reading is not stored as new-credible.
 *
 * The model itself is the remote service. This file stands in only for that
 * HTTP response, in the shape @ai-sdk/google 4.0.x parses
 * (candidates[0].content.parts[].text, finishReason STOP). generateText,
 * Output.object schema checks, and classifyInboxWithAssistant stay real.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { PersonalContext } from "../src/lib/inbox/personal-context.ts";

process.env.SEER_DATA_DIR = mkdtempSync(
  path.join(tmpdir(), "seer-unconfirmed-sender-"),
);
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
process.env.GEMINI_API_KEY = "configured-for-test";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;

type TriageAction =
  | "respond"
  | "read_and_archive"
  | "read_and_delete"
  | "delete_now"
  | "act_today"
  | "unsubscribe"
  | "review_subscription"
  | "glance_promo"
  | "needs_review";

type Script = {
  action: TriageAction;
  sender: "person" | "machine";
  credible: boolean;
};

const scripts = new Map<string, Script>();
const modelRequests: string[] = [];

function textParts(body: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") found.push(record.text);
    for (const value of Object.values(record)) walk(value);
  };
  walk(body);
  return found;
}

function idsInPrompt(raw: string): string[] {
  const body = JSON.parse(raw) as unknown;
  const ids: string[] = [];
  for (const text of textParts(body)) {
    const start = text.indexOf("[{");
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start)) as { id?: string }[];
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed) {
        if (row && typeof row.id === "string") ids.push(row.id);
      }
    } catch {
      /* system prompt and other text parts are not the item list */
    }
  }
  return ids;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const host = new URL(url).host;
  if (
    host !== "generativelanguage.googleapis.com" ||
    !url.includes(":generateContent")
  ) {
    return realFetch(input, init);
  }
  const raw =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : "";
  modelRequests.push(raw);
  const ids = idsInPrompt(raw);
  const items = ids.map((id) => {
    const script = scripts.get(id);
    if (!script) {
      throw new Error(`model stand-in has no judgment for ${id}`);
    }
    return {
      id,
      action: script.action,
      confidence: 0.91,
      reason: "stand-in judgment",
      instruction: "stand-in instruction",
      task: "none",
      category: "Other",
      sender: script.sender,
      credible: script.credible,
      importance: script.action === "delete_now" ? 0 : 1,
      deed: "none",
    };
  });
  // Shape read from @ai-sdk/google responseSchema / doGenerate:
  // candidates[0].content.parts[].text and finishReason STOP → unified "stop".
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ items }) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 12,
        totalTokenCount: 24,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { classifyInboxWithAssistant, getAssistantStatus } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { loadPeople } = await import("../src/lib/store/people.ts");
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");

const ATTACKER = "pat.harper@cold-example.test";
const BODY_MARKER = "HARBOR-LMA-PAPERWORK-ASK";
const CREDIBLE_BODY =
  "Could you send the signed LMA paperwork for the Harbor project this week? " +
  `It is the personal matter we discussed with Dana. ${BODY_MARKER}`;

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

function history(account: string, sentTo = 0): MailHistory {
  return {
    accountEmail: account,
    builtAt: "2026-11-20T00:00:00.000Z",
    contacts:
      sentTo > 0
        ? {
            [ATTACKER]: {
              email: ATTACKER,
              sentTo,
              receivedFrom: 1,
              lastSentAt: "2026-11-18T00:00:00.000Z",
            },
          }
        : {},
    engagedCount: sentTo > 0 ? 1 : 0,
    contactCount: sentTo > 0 ? 1 : 0,
    repliedThreads: {},
  };
}

function mail(
  id: string,
  fromEmail: string,
  subject: string,
  snippet: string,
) {
  return {
    id,
    fromEmail,
    fromName: "Pat Harper",
    subject,
    snippet,
    threadId: `thread-${id}`,
    receivedAt: "2026-11-20T12:00:00.000Z",
  };
}

function enableModel() {
  process.env.GEMINI_API_KEY = "configured-for-test";
  process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
}

function disableModel() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL;
}

async function grade(
  account: string,
  items: ReturnType<typeof mail>[],
  opts?: {
    history?: MailHistory;
    personal?: PersonalContext;
    override?: TriageAction | null;
    defer?: boolean;
    fetchBody?: boolean;
  },
) {
  let deferred: (() => Promise<void>) | undefined;
  const decisions = await classifyInboxWithAssistant(
    account,
    items,
    opts?.history ?? history(account),
    () => opts?.override ?? null,
    classifyMessage,
    {
      personal: opts?.personal,
      geminiEnabled: true,
      fetchBody: opts?.fetchBody
        ? async () => CREDIBLE_BODY
        : undefined,
      deferAi: opts?.defer ?? false,
      onDeferred: opts?.defer
        ? (run) => {
            deferred = run;
          }
        : undefined,
    },
  );
  if (deferred) await deferred();
  return decisions;
}

console.log("unconfirmed sender delete bypass");

await check(
  "a model reading of attacker mail is sent the body and does not store new-credible",
  async () => {
    enableModel();
    const id = "inline-first";
    scripts.set(id, { action: "respond", sender: "person", credible: true });
    const before = modelRequests.length;
    const decisions = await grade(
      "inline@mailbox.test",
      [mail(id, ATTACKER, "Harbor project paperwork", "short preview")],
      { fetchBody: true },
    );
    const sent = modelRequests.slice(before).join("\n");
    assert.match(sent, new RegExp(BODY_MARKER));
    assert.match(sent, /A credible person is NEVER deleted/);
    assert.equal(decisions.get(id)?.source, "gemini");
    assert.equal(decisions.get(id)?.senderKind, "person");
    assert.equal(decisions.get(id)?.credible, true);
    const status = getAssistantStatus();
    assert.equal(
      status.error,
      null,
      `model path did not complete: ${status.error ?? ""}`,
    );
    const people = await loadPeople("inline@mailbox.test");
    assert.notEqual(people[ATTACKER]?.tier, "new-credible");
    assert.notEqual(people[ATTACKER]?.by, "ai");
  },
);

await check(
  "later model delete, unsubscribe, read-and-delete, and glance stay trash",
  async () => {
    enableModel();
    const cases: { id: string; action: TriageAction; subject: string }[] = [
      { id: "later-delete", action: "delete_now", subject: "Weekly noise" },
      {
        id: "later-unsubscribe",
        action: "unsubscribe",
        subject: "List mail",
      },
      {
        id: "later-read-delete",
        action: "read_and_delete",
        subject: "Skim once",
      },
      { id: "later-glance", action: "glance_promo", subject: "A deal" },
    ];
    for (const row of cases) {
      scripts.set(row.id, {
        action: row.action,
        sender: "machine",
        credible: false,
      });
    }
    const decisions = await grade(
      "inline@mailbox.test",
      cases.map((row) =>
        mail(
          row.id,
          ATTACKER,
          row.subject,
          "Nothing in this note changes what you do today.",
        ),
      ),
      { fetchBody: true },
    );
    const mismatches: string[] = [];
    for (const row of cases) {
      const got = decisions.get(row.id);
      if (got?.action !== row.action) {
        mismatches.push(`${row.id}: ${got?.action} (${got?.debug.ruleId})`);
      } else if (primaryMailAction(got.action) !== "trash") {
        mismatches.push(`${row.id}: filed as ${primaryMailAction(got.action)}`);
      } else if (got.debug.ruleId === "person-protect") {
        mismatches.push(`${row.id}: person-protect`);
      }
    }
    assert.deepEqual(mismatches, []);
    const people = await loadPeople("inline@mailbox.test");
    assert.notEqual(people[ATTACKER]?.tier, "new-credible");
  },
);

await check(
  "a cached later load still deletes after the model already said delete",
  async () => {
    enableModel();
    scripts.set("later-delete", {
      action: "delete_now",
      sender: "machine",
      credible: false,
    });
    const before = modelRequests.length;
    const decisions = await grade(
      "inline@mailbox.test",
      [
        mail(
          "later-delete",
          ATTACKER,
          "Weekly noise",
          "Nothing in this note changes what you do today.",
        ),
      ],
      { fetchBody: true },
    );
    assert.equal(modelRequests.length, before, "decision cache should answer");
    assert.equal(decisions.get("later-delete")?.action, "delete_now");
    assert.equal(decisions.get("later-delete")?.cached, true);
    assert.equal(
      primaryMailAction(decisions.get("later-delete")!.action),
      "trash",
    );
  },
);

await check(
  "deferred inbox grading does not protect the sender on the next load",
  async () => {
    enableModel();
    const first = "defer-first";
    const later = "defer-later";
    scripts.set(first, { action: "respond", sender: "person", credible: true });
    scripts.set(later, {
      action: "delete_now",
      sender: "machine",
      credible: false,
    });
    await grade(
      "defer@mailbox.test",
      [mail(first, ATTACKER, "Harbor project paperwork", "short preview")],
      { fetchBody: true, defer: true },
    );
    const planted = await loadPeople("defer@mailbox.test");
    const decisions = await grade(
      "defer@mailbox.test",
      [
        mail(
          later,
          ATTACKER,
          "Weekly noise",
          "Nothing in this note changes what you do today.",
        ),
      ],
      { fetchBody: true },
    );
    const laterDecision = decisions.get(later);
    const problems: string[] = [];
    if (planted[ATTACKER]?.tier === "new-credible") {
      problems.push("deferred grading stored new-credible");
    }
    if (laterDecision?.action !== "delete_now") {
      problems.push(
        `later action ${laterDecision?.action} (${laterDecision?.debug.ruleId})`,
      );
    }
    if (
      laterDecision &&
      primaryMailAction(laterDecision.action) !== "trash"
    ) {
      problems.push(`filed as ${primaryMailAction(laterDecision.action)}`);
    }
    assert.deepEqual(problems, []);
  },
);

await check(
  "rules stay in force when the model is down and the only signal is that reading",
  async () => {
    enableModel();
    const first = "rules-first";
    scripts.set(first, { action: "respond", sender: "person", credible: true });
    await grade(
      "rules@mailbox.test",
      [mail(first, ATTACKER, "Harbor project paperwork", "short preview")],
      { fetchBody: true },
    );
    disableModel();
    const rows = [
      mail(
        "rules-delete",
        ATTACKER,
        "Shop notice",
        "Flash deal shop now on the east wall paint.",
      ),
      mail(
        "rules-unsub",
        ATTACKER,
        "List notice",
        "Flash deal shop now. Unsubscribe from this list.",
      ),
        mail(
          "rules-skim",
          ATTACKER,
          "Paint note",
          "The lobby paint color is a flat gray across the east wall.",
        ),
    ];
    const decisions = await grade("rules@mailbox.test", rows);
    const mismatches: string[] = [];
    for (const item of rows) {
      const rules = classifyMessage(
        {
          fromEmail: item.fromEmail,
          fromName: item.fromName,
          subject: item.subject,
          snippet: item.snippet,
        },
        null,
        history("rules@mailbox.test"),
      );
      const got = decisions.get(item.id);
      if (got?.action !== rules.action || got.debug.ruleId !== `rules:${rules.debug.ruleId}`) {
        mismatches.push(
          `${item.id}: got ${got?.action} (${got?.debug.ruleId}), rules ${rules.action} (${rules.debug.ruleId})`,
        );
      }
    }
    assert.deepEqual(mismatches, []);
  },
);

await check(
  "sent mail, a saved contact, and a meeting still block deletion",
  async () => {
    enableModel();
    const sentId = "protect-sent";
    const contactId = "protect-contact";
    const meetingId = "protect-meeting";
    for (const id of [sentId, contactId, meetingId]) {
      scripts.set(id, {
        action: "delete_now",
        sender: "machine",
        credible: false,
      });
    }
    const personal = {
      builtAt: "2026-11-20T00:00:00.000Z",
      contacts: [] as string[],
      events: [] as PersonalContext["events"],
    };
    const sent = await grade(
      "protect-sent@mailbox.test",
      [mail(sentId, ATTACKER, "Weekly noise", "Nothing to do with this note.")],
      { history: history("protect-sent@mailbox.test", 2), fetchBody: true },
    );
    personal.contacts = [ATTACKER];
    const contact = await grade(
      "protect-contact@mailbox.test",
      [
        mail(
          contactId,
          ATTACKER,
          "Weekly noise",
          "Nothing to do with this note.",
        ),
      ],
      { personal, fetchBody: true },
    );
    personal.contacts = [];
    personal.events = [
      {
        subject: "Harbor review",
        startsAt: "2026-11-21T15:00:00.000Z",
        attendees: [ATTACKER],
      },
    ];
    const meeting = await grade(
      "protect-meeting@mailbox.test",
      [
        mail(
          meetingId,
          ATTACKER,
          "Weekly noise",
          "Nothing to do with this note.",
        ),
      ],
      { personal, fetchBody: true },
    );
    assert.equal(sent.get(sentId)?.action, "read_and_archive");
    assert.equal(contact.get(contactId)?.action, "read_and_archive");
    assert.equal(meeting.get(meetingId)?.action, "read_and_archive");
    assert.equal(primaryMailAction(sent.get(sentId)!.action), "archive");
  },
);

await check(
  "a taught delete still wins over a stored person tier",
  async () => {
    enableModel();
    const id = "taught-delete";
    scripts.set(id, {
      action: "respond",
      sender: "person",
      credible: true,
    });
    const decisions = await grade(
      "inline@mailbox.test",
      [mail(id, ATTACKER, "Weekly noise", "Nothing to do with this note.")],
      { override: "delete_now" },
    );
    assert.equal(decisions.get(id)?.action, "delete_now");
    assert.equal(decisions.get(id)?.source, "override");
    assert.equal(primaryMailAction(decisions.get(id)!.action), "trash");
  },
);

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
