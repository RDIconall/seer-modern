/**
 * Spec: appointment phrasing in mail an attacker can send must not force
 * an act-today grade. These tests fail while that rewrite is present.
 *
 * Run:
 *   npx tsx scripts/appointment-floor-spoof.test.mts
 *
 * The grader is the one the mailbox, message, today, brief, catch-up,
 * all-tasks, and sync routes call. Provider fetches are not executed;
 * subject, snippet, and sender are the fields those routes copy through.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-appt-floor-"));
process.env.SEER_DATA_DIR = dataDir;
for (const name of [
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "SEER_V2_DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
]) {
  delete process.env[name];
}

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { buildActionGuideQuick, buildActionGuideDetailed } = await import(
  "../src/lib/inbox/action-guide.ts"
);
const { classifyInboxWithAssistant, PROMPT_VERSION } = await import(
  "../src/lib/inbox/gemini-triage.ts"
);
const { saveDecisions } = await import("../src/lib/store/decision-cache.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");

import type { TriageAction } from "../src/lib/inbox/classify.ts";
import type { MailHistory } from "../src/lib/inbox/mail-history.ts";
import type { PersonalContext } from "../src/lib/inbox/personal-context.ts";
import type { ActionMemory } from "../src/lib/store/action-memory.ts";
import type { GeminiTriageItem, AssistantClassifyResult } from "../src/lib/inbox/gemini-triage.ts";
import type { SeerLabelStore } from "../src/lib/mail/seer-labels.ts";

const failures: string[] = [];

function recent(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function historyFor(
  account: string,
  contacts: MailHistory["contacts"],
): MailHistory {
  return {
    accountEmail: account,
    builtAt: recent(0),
    contacts,
    engagedCount: Object.values(contacts).filter((c) => c.sentTo > 0).length,
    contactCount: Object.keys(contacts).length,
  };
}

function item(
  partial: Partial<GeminiTriageItem> & Pick<GeminiTriageItem, "id" | "fromEmail" | "subject">,
): GeminiTriageItem {
  return {
    fromName: partial.fromName ?? "Notice",
    snippet: partial.snippet ?? "",
    receivedAt: partial.receivedAt ?? recent(2),
    ...partial,
  };
}

/** Same body→snippet cut the message route applies before grading. */
function messageRouteSnippet(htmlBody: string, preview: string): string {
  const bodyText = htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return (bodyText || preview).slice(0, 2000);
}

type GradeOpts = {
  history?: MailHistory | null;
  personal?: PersonalContext;
  actionMemory?: ActionMemory;
  override?: TriageAction | null;
  labels?: SeerLabelStore;
  /** Message view, brief, and catch-up pass false. Mailbox defers the model. */
  mode?: "message" | "mailbox";
};

async function grade(
  account: string,
  messages: GeminiTriageItem[],
  opts: GradeOpts = {},
): Promise<Map<string, AssistantClassifyResult>> {
  const deferred: Array<() => Promise<void>> = [];
  return classifyInboxWithAssistant(
    account,
    messages,
    opts.history ?? null,
    () => opts.override ?? null,
    classifyMessage,
    {
      personal: opts.personal,
      actionMemory: opts.actionMemory,
      labels: opts.labels,
      geminiEnabled: opts.mode === "mailbox" ? true : false,
      deferAi: opts.mode === "mailbox",
      onDeferred: (run) => {
        deferred.push(run);
      },
    },
  );
}

function describe(result: AssistantClassifyResult | undefined): string {
  if (!result) return "missing";
  return `${result.action}/${result.confidence} source=${result.source} rule=${result.debug.ruleId} task=${result.task ?? ""} reason=${result.reason}`;
}

function forbidForcedVisit(
  name: string,
  result: AssistantClassifyResult | undefined,
  guideTask?: string,
  guideInstruction?: string,
) {
  const forced =
    !result ||
    result.action === "act_today" ||
    result.task === "Be there — visit scheduled" ||
    result.reason === "Confirmed appointment — you may need to be there" ||
    result.debug.ruleId === "appointment-hold" ||
    result.debug.ruleId === "appointment-floor" ||
    result.debug.ruleId.endsWith("+needs-you-floor") ||
    guideTask === "Be there — visit scheduled" ||
    guideInstruction ===
      "Someone is coming (or you're expected somewhere). Check the time window.";
  if (forced) {
    failures.push(
      `${name}: forced a visit grade (${describe(result)}; guideTask=${guideTask ?? ""})`,
    );
  }
}

async function guides(result: AssistantClassifyResult, subject: string, snippet: string) {
  const quick = buildActionGuideQuick(result, subject, undefined, snippet);
  const detailed = await buildActionGuideDetailed(
    result,
    subject,
    snippet,
    snippet,
  );
  return { quick, detailed };
}

const PHRASES: Array<{ subject: string; snippet: string }> = [
  {
    subject: "Your appointment is confirmed",
    snippet: "Please be there. Click to view the details.",
  },
  {
    subject: "Service update",
    snippet: "Your installation has been scheduled for Thursday.",
  },
  {
    subject: "Window",
    snippet: "A technician is arriving between 9am and 1pm.",
  },
];

let n = 0;
function account(): string {
  n += 1;
  return `victim-${n}@mailbox.example`;
}

try {
  // Rules grader, before any sender history is consulted.
  for (const phrase of PHRASES) {
    const rules = classifyMessage({
      fromEmail: "appointments@mail.evil.example",
      fromName: "City Clinic",
      subject: phrase.subject,
      snippet: phrase.snippet,
    });
    if (
      rules.action === "act_today" ||
      rules.debug.ruleId === "appointment-hold" ||
      rules.confidence === "HIGH" && rules.reason.includes("Confirmed appointment")
    ) {
      failures.push(
        `classifyMessage unknown sender [${phrase.subject}]: ${rules.action}/${rules.confidence} rule=${rules.debug.ruleId} reason=${rules.reason}`,
      );
    }
  }

  // Message view: model off, phrase lives in the body past the preview.
  {
    const who = account();
    const preview = "Hello, this is a short preview.";
    const html =
      "<p>Hello, this is a short preview.</p><p>Your appointment is confirmed and the technician is arriving between 9am and 1pm.</p>";
    const snippet = messageRouteSnippet(html, preview);
    const subject = "Please read";
    const message = item({
      id: "body-phrase",
      fromEmail: "notify@spoofed-visits.example",
      fromName: "Appointments",
      subject,
      snippet,
      receivedAt: recent(1),
    });
    for (const mode of ["message", "mailbox"] as const) {
      const decisions = await grade(who + mode, [message], { mode });
      const result = decisions.get(message.id);
      const shown = result
        ? await guides(result, subject, snippet)
        : undefined;
      forbidForcedVisit(
        `message body phrase via ${mode}`,
        result,
        shown?.quick.task,
        shown?.detailed.instruction,
      );
      if (shown && shown.quick.action === "act_today" && shown.quick.confidence === "HIGH") {
        failures.push(
          `guide ${mode} shows high-confidence act today: ${shown.quick.task} / ${shown.quick.label}`,
        );
      }
    }
  }

  // A real carrier status is graded delete, then the floor rewrites it.
  {
    const who = account();
    const subject = "Your shipment is scheduled for delivery tomorrow";
    const snippet = "Arriving between 9:00 AM and 1:00 PM. Track your package.";
    const message = item({
      id: "ups-status",
      fromEmail: "tracking@ups.com",
      fromName: "UPS",
      subject,
      snippet,
      receivedAt: recent(2),
    });
    const rules = classifyMessage({
      fromEmail: message.fromEmail,
      fromName: message.fromName,
      subject,
      snippet,
    });
    assert.equal(
      rules.action,
      "delete_now",
      `carrier status should grade delete before the floor, got ${rules.debug.ruleId}`,
    );
    const decisions = await grade(who, [message], { mode: "message" });
    const result = decisions.get(message.id);
    const shown = result ? await guides(result, subject, snippet) : undefined;
    if (result?.action !== "delete_now" || result.debug.ruleId === "appointment-floor") {
      failures.push(
        `carrier status rewritten after a lower rules grade: ${describe(result)}; guide=${shown?.quick.task}`,
      );
    }
    if (shown?.quick.task === "Be there — visit scheduled") {
      failures.push("carrier status guide tells the user to be there");
    }
  }

  // Stored model grade (the decision cache the next load reads) must stand.
  {
    const who = account();
    const subject = "Your appointment is confirmed";
    const snippet = "Has been scheduled. Arriving between 8 and 12.";
    const message = item({
      id: "cached-model",
      fromEmail: "robot@news.evil.example",
      fromName: "Clinic Alerts",
      subject,
      snippet,
      receivedAt: recent(3),
    });
    await saveDecisions(
      who,
      new Map([
        [
          message.id,
          {
            action: "delete_now",
            confidence: "HIGH",
            reason: "Unsolicited notice",
            instruction: "Safe to delete without opening.",
            task: "Nothing — delete it",
            source: "gemini",
            ruleId: "gemini:stored-model-grade",
            ts: Date.now(),
            v: PROMPT_VERSION,
          },
        ],
      ]),
    );
    const decisions = await grade(who, [message], { mode: "mailbox" });
    const result = decisions.get(message.id);
    if (result?.action !== "delete_now" || result.task === "Be there — visit scheduled") {
      failures.push(
        `stored model delete was overturned by appointment phrasing: ${describe(result)}`,
      );
    }
  }

  // A saved non-dismissive label is still raised to act today.
  {
    const who = account();
    const subject = "Reminder: your appointment";
    const snippet = "Your visit is scheduled for Friday.";
    const message = item({
      id: "labeled",
      fromEmail: "hello@random-clinic.example",
      fromName: "Random Clinic",
      subject,
      snippet,
      labelIds: ["LBL_SUB"],
      receivedAt: recent(4),
    });
    await kvSet(`labels-era:${who}`, PROMPT_VERSION);
    const labels: SeerLabelStore = {
      lookup: (row) =>
        row.labelIds?.includes("LBL_SUB") ? "review_subscription" : null,
      persist: async () => {},
    };
    const decisions = await grade(who, [message], { mode: "message", labels });
    const result = decisions.get(message.id);
    if (result?.action !== "review_subscription") {
      failures.push(
        `saved review label was rewritten from appointment phrasing: ${describe(result)}`,
      );
    }
  }

  // Taught delete and learned trash are not confirmation of a visit.
  {
    const who = account();
    const message = item({
      id: "taught-delete",
      fromEmail: "deals@promo.evil.example",
      fromName: "Deals",
      subject: "Your appointment is booked",
      snippet: "Arriving between noon and 4.",
      receivedAt: recent(1),
    });
    const decisions = await grade(who, [message], {
      mode: "message",
      override: "delete_now",
    });
    const result = decisions.get(message.id);
    if (result?.action !== "delete_now" || result.source !== "override") {
      failures.push(
        `taught delete did not survive appointment phrasing: ${describe(result)}`,
      );
    }
  }
  {
    const who = account();
    const fromEmail = "blasts@lists.evil.example";
    const message = item({
      id: "learned-trash",
      fromEmail,
      fromName: "Lists",
      subject: "Job scheduled",
      snippet: "Our team will arrive tomorrow morning.",
      receivedAt: recent(2),
    });
    const memory: ActionMemory = {
      [fromEmail]: { archive: 0, trash: 4, lastAt: recent(1) },
    };
    const decisions = await grade(who, [message], {
      mode: "mailbox",
      actionMemory: memory,
    });
    const result = decisions.get(message.id);
    if (result?.action !== "delete_now" || result.source !== "learned") {
      failures.push(
        `learned trash did not survive appointment phrasing: ${describe(result)}`,
      );
    }
  }

  // The sender on the calendar is not the stranger in the same batch.
  {
    const who = account();
    const plumber = "plumber@homeservice.example";
    const personal: PersonalContext = {
      builtAt: recent(0),
      contacts: [],
      events: [
        {
          id: "ev-heater",
          subject: "Water heater",
          startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          attendees: [plumber],
          myStatus: "accepted",
        },
      ],
    };
    const known = item({
      id: "known-meeting",
      fromEmail: plumber,
      fromName: "Pat Plumber",
      subject: "See you Thursday",
      snippet: "I will be at the house in the morning.",
      receivedAt: recent(1),
    });
    const spoof = item({
      id: "spoof-batch",
      fromEmail: "appointments@mail.evil.example",
      fromName: "Pat Plumber",
      subject: "Your appointment is confirmed",
      snippet: "Has been scheduled. Arriving between 9 and 1. Be there.",
      receivedAt: recent(1),
    });
    const decisions = await grade(who, [known, spoof], {
      mode: "mailbox",
      personal,
    });
    const knownResult = decisions.get(known.id);
    const spoofResult = decisions.get(spoof.id);
    if (knownResult?.action !== "act_today") {
      failures.push(
        `sender you are actually meeting was not actionable: ${describe(knownResult)}`,
      );
    }
    const shown = spoofResult
      ? await guides(spoofResult, spoof.subject, spoof.snippet)
      : undefined;
    forbidForcedVisit(
      "spoof beside a real meeting",
      spoofResult,
      shown?.quick.task,
      shown?.detailed.instruction,
    );
  }

  // People the user already writes to, or who write often, may stay urgent.
  {
    const who = account();
    const engagedEmail = "sam@clinic.example";
    const knownEmail = "river@practice.example";
    const history = historyFor(who, {
      [engagedEmail]: {
        email: engagedEmail,
        sentTo: 3,
        receivedFrom: 2,
        lastSentAt: recent(2),
      },
      [knownEmail]: {
        email: knownEmail,
        sentTo: 0,
        receivedFrom: 5,
        lastReceivedAt: recent(1),
      },
    });
    const engaged = item({
      id: "engaged",
      fromEmail: engagedEmail,
      fromName: "Sam",
      subject: "Your appointment is confirmed",
      snippet: "See you at the office.",
    });
    const frequent = item({
      id: "frequent",
      fromEmail: knownEmail,
      fromName: "River",
      subject: "Visit",
      snippet: "Your service has been scheduled.",
    });
    const stranger = item({
      id: "stranger",
      fromEmail: "newclinic@mail.evil.example",
      fromName: "Sam",
      subject: "Your appointment is confirmed",
      snippet: "Your service has been scheduled.",
    });
    const decisions = await grade(who, [engaged, frequent, stranger], {
      mode: "message",
      history,
    });
    if (decisions.get(engaged.id)?.action !== "act_today") {
      failures.push(
        `mail from someone you write to lost act today: ${describe(decisions.get(engaged.id))}`,
      );
    }
    if (decisions.get(frequent.id)?.action !== "act_today") {
      failures.push(
        `mail from a frequent sender lost act today: ${describe(decisions.get(frequent.id))}`,
      );
    }
    forbidForcedVisit("stranger copied a known sender's name", decisions.get(stranger.id));
  }

  // An explicit act-today teaching still wins, and a stale visit ages out.
  {
    const who = account();
    const kept = item({
      id: "user-confirmed",
      fromEmail: "desk@clinic.example",
      fromName: "Front Desk",
      subject: "Your appointment is confirmed",
      snippet: "Arriving between 2 and 4.",
    });
    const decisions = await grade(who, [kept], {
      mode: "message",
      override: "act_today",
    });
    const result = decisions.get(kept.id);
    if (result?.action !== "act_today" || result.source !== "override") {
      failures.push(`user-confirmed act today was dropped: ${describe(result)}`);
    }
  }
  {
    const who = account();
    const old = item({
      id: "stale",
      fromEmail: "old@mail.evil.example",
      fromName: "Old Notice",
      subject: "Your appointment is confirmed",
      snippet: "Has been scheduled.",
      receivedAt: recent(9),
    });
    const decisions = await grade(who, [old], { mode: "message" });
    forbidForcedVisit("nine-day-old spoof", decisions.get(old.id));
  }

  // Unrelated cold mail is unchanged.
  {
    const rules = classifyMessage({
      fromEmail: "noreply@news.example",
      fromName: "News",
      subject: "Weekly digest",
      snippet: "Ten links you might like.",
    });
    assert.notEqual(rules.action, "act_today");
    assert.notEqual(rules.debug.ruleId, "appointment-hold");
  }

  // A real unanswered invitation still asks for an RSVP.
  {
    const who = account();
    const personal: PersonalContext = {
      builtAt: recent(0),
      contacts: [],
      events: [
        {
          id: "ev-standup",
          subject: "Standup",
          startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          attendees: ["boss@work.example"],
          myStatus: "needsAction",
        },
      ],
    };
    const message = item({
      id: "invite",
      fromEmail: "calendar-notification@google.com",
      fromName: "Google Calendar",
      subject: "Invitation: Standup",
      snippet: "You have been invited.",
      receivedAt: recent(0),
    });
    const decisions = await grade(who, [message], { mode: "message", personal });
    const result = decisions.get(message.id);
    if (result?.action !== "act_today" || result.debug.ruleId !== "invite-needs-rsvp") {
      failures.push(`unanswered calendar invite was not an RSVP: ${describe(result)}`);
    }
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`appointment-floor spoof: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("appointment-floor spoof: passed");
