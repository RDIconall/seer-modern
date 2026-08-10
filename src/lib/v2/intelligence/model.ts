import { generateText, Output, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import type { Conversation } from "../providers/types";
import { readResultSchema, type ReadResult } from "./schema";
import { readableBody } from "./html-text";
import type { ReaderModel } from "./reader";

/**
 * The real chief-of-staff model, behind the injectable ReaderModel interface.
 * One structured call per conversation over the WHOLE thread plus the context
 * packet. There is no snippet path and no keyword fallback: if the model fails,
 * the reader records `undecided` and retries later.
 */

const SYSTEM = `You are a chief of staff reading one email conversation for a busy executive.

Decide two things and nothing else:

1. HOME — where this conversation belongs:
   - "matter": live work with a counterparty that must be tracked (a real ask of the user, a negotiation, a decision they owe, a signature/approval/regulatory/legal/payment step, or someone waiting on their reply). An automated notification, reminder, trial/billing notice, product announcement, or status update is NOT a matter no matter how urgent it sounds — being time-sensitive is not the same as being unresolved work with a counterparty. When you choose "matter" you MUST set matterRef to the ongoing real-world concern, named as a person would say it ("Roche anti-TPO pricing", "Tosoh contract amendment") — never the email's subject line and never an imperative.
   - "record": no live story, but worth keeping (receipt, executed contract, invoice, statement, confirmation).
   - "delete": the useful meaning (if any) has been captured in YIELDS and the email itself is not needed.
   - "undecided": you cannot responsibly decide.
   Judge from MEANING, never the sender's shape. A no-reply address can carry an approval; a real person can send pure noise.

2. YIELDS — business meaning worth keeping even if the email is deleted:
   - "matter_connection": the body touches a live matter, client, prospect, competitor, or person in the user's world. Set matterRef to the matter it touches. ONLY when the CONTEXT names such a matter/person — never invent one.
   - "worth_reading": an article/report the user is likely to want, and ONLY when it matches an interest the CONTEXT states.
   - "fact"/"contact": a concrete fact or new contact worth retaining.
   Surface nothing generic. No connection without evidence in the context.

Set obligation=true when a signature, approval, regulatory, legal, or payment step is still outstanding for the user. Set owner to who must act next. Set ask to the specific thing wanted, or "nothing — informational".

Set dueDate ONLY when the email states a real date by which something must happen or a window closes ("respond by August 30", "expires August 19", "renews on 07/11/2026", "bidding closes Friday"). Use YYYY-MM-DD. Never infer or guess a date, and never use the date the email was sent. Leave it out when the email states none.

Distinguish a GENERIC BROADCAST from a DIRECT DEMAND. A sourcing/procurement notice sent to every vendor ("open for bidding", "event opens in 1 hour", "response time revised"), a portal digest, or an automated status update is ambient — owner is usually "nobody" or "them". But the SAME channel can carry a message addressed to the user by name, quoting them, or explicitly asking them to respond, decide, approve, or sign — especially from a senior or named counterparty contact. That is owner "you" with a real ask. Judge from the recipients (is the user in To, or is this a broadcast?) and the body (is the user personally being asked?), never from the sender's address alone.

Use the CONTEXT block as sourced evidence: [explicit]/[system] outrank your reading; [inference] is a hint. Absence of relationship is itself evidence toward fyi/disposable — but a real ask, signature, or deadline in the body always wins.`;

/** "Raiane Sousa Gaspar <raiane@roche.com>" — what a paste would show. */
function addressLine(a: { email: string; name?: string }): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

function conversationPayload(conversation: Conversation) {
  return {
    subject: conversation.subject,
    messages: conversation.messages.map((m) => ({
      // Names matter: seniority and identity live in them, not the address.
      from: addressLine(m.from),
      to: m.to.map(addressLine),
      cc: m.cc.map(addressLine),
      sentAt: m.sentAt,
      ...(m.attachments.length
        ? { attachments: m.attachments.map((a) => a.filename) }
        : {}),
      body: readableBody(m),
    })),
  };
}

/**
 * The default is a FLASH-LITE tier, not full Flash. Triage is a
 * classification task, and the Flash tiers cost ~5x input / 3x output for no
 * material quality gain here. Pin the cheap tier and let SEER_GEMINI_MODEL
 * override when a heavier model is genuinely needed.
 */
const DEFAULT_MODEL = "gemini-flash-lite-latest";

function resolveModel(): LanguageModel | string {
  const forced = process.env.SEER_GEMINI_MODEL?.trim();
  const googleKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    return google((forced || DEFAULT_MODEL).replace(/^google\//, ""));
  }
  // Vercel AI Gateway string model (OIDC / AI_GATEWAY_API_KEY).
  return forced || `google/${DEFAULT_MODEL}`;
}

export const defaultReaderModel: ReaderModel = async ({
  conversation,
  contextText,
}): Promise<ReadResult> => {
  const { output } = await generateText({
    model: resolveModel(),
    temperature: 0,
    // ONE attempt. Retries multiply cost on exactly the mail that thrashes;
    // a failed read simply stays `undecided` and is retried on the next tick,
    // by which point the model or the mail may have settled.
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(60_000),
    output: Output.object({ schema: readResultSchema }),
    // Disable "thinking" tokens. On a paste-and-classify task they added
    // little accuracy while dominating the bill — a trivial prompt produced
    // ~10x more thinking tokens than output, all billed at the output rate.
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    },
    system: SYSTEM,
    prompt: JSON.stringify({
      context: contextText || "no prior relationship on record",
      conversation: conversationPayload(conversation),
    }),
  });
  return output;
};
