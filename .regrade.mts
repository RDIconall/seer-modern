/* Full inbox regrade under prompt v20 — writes REAL decision cache and
   Gmail labels so the app serves fresh verdicts instantly. */
import { Redis } from "@upstash/redis";
import { classifyInboxWithAssistant, getAssistantStatus } from "/workspace/src/lib/inbox/gemini-triage";
import { classifyMessage } from "/workspace/src/lib/inbox/classify";
import { buildMailHistory } from "/workspace/src/lib/inbox/mail-history";
import { listGmailFolder, getGmailMessage } from "/workspace/src/lib/mail/gmail";
import { makeGmailLabelStore } from "/workspace/src/lib/mail/seer-labels";
import { getSenderOverride } from "/workspace/src/lib/store/senders";
import { loadActionMemory } from "/workspace/src/lib/store/action-memory";
import { loadRepliedThreads } from "/workspace/src/lib/store/replied-threads";
import { loadUserProfile } from "/workspace/src/lib/store/user-profile";

const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN!, automaticDeserialization: false });
const store = JSON.parse((await redis.get("seer:accounts")) as string);
const token = store.accounts[0].accessToken as string;
const ACCOUNT = store.accounts[0].email as string;

const [inbox, sent] = await Promise.all([
  listGmailFolder(token, "inbox", 400),
  listGmailFolder(token, "sent", 80),
]);
const history = buildMailHistory(ACCOUNT, inbox, sent);
const [profile, actionMemory, replied, labels] = await Promise.all([
  loadUserProfile(ACCOUNT),
  loadActionMemory(ACCOUNT),
  loadRepliedThreads(ACCOUNT),
  makeGmailLabelStore(token, ACCOUNT),
]);

const items = inbox.map((m) => ({
  id: m.id, fromEmail: m.fromEmail, fromName: m.fromName,
  subject: m.subject, snippet: m.snippet, labelIds: m.labelIds,
  threadId: m.threadId, receivedAt: m.receivedAt,
}));

console.log(`Regrading ${items.length} inbox emails under v20…`);
const totals: Record<string, number> = {};
for (let pass = 1; pass <= 8; pass++) {
  const decisions = await classifyInboxWithAssistant(
    ACCOUNT, items, history,
    (email) => getSenderOverride(email),
    classifyMessage,
    {
      profile, actionMemory, replied, labels,
      geminiEnabled: true,
      fetchBody: async (id) => {
        const msg = await getGmailMessage(token, id);
        return msg.textBody || msg.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      },
    },
  );
  const counts: Record<string, number> = {};
  let freshGemini = 0;
  for (const [, r] of decisions) {
    counts[r.source] = (counts[r.source] ?? 0) + 1;
    if (r.source === "gemini" && !r.cached) freshGemini += 1;
  }
  console.log(`pass ${pass}:`, JSON.stringify(counts), "fresh-gemini:", freshGemini, "engine:", JSON.stringify(getAssistantStatus()));
  Object.assign(totals, counts);
  if (freshGemini === 0) break;
}

// Final action distribution
const decisions = await classifyInboxWithAssistant(
  ACCOUNT, items, history, (email) => getSenderOverride(email), classifyMessage,
  { profile, actionMemory, replied, labels, geminiEnabled: false },
);
const byAction: Record<string, number> = {};
for (const [, r] of decisions) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
console.log("FINAL action distribution:", JSON.stringify(byAction, null, 1));
