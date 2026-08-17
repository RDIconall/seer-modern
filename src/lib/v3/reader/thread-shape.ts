import type { Address, Conversation, Message } from "@/lib/v2/providers/types";
import { readableBody } from "@/lib/v2/intelligence/html-text";

/**
 * The shape of a conversation, which is not the list of messages it is stored
 * as.
 *
 * Two things make long threads unreadable, and every mail client does both.
 *
 * The first is flattening two lanes into one. A thread has a TRUNK — what the
 * counterparty can see — and it has BRANCHES: the forward to a colleague and
 * everything that came back. Interleaved by timestamp, following what Lumos
 * knows means wading through your own team's working out. Kept apart, each lane
 * reads on its own.
 *
 * The second is quoted history. By the sixth turn the same opening paragraph is
 * on the screen six times, and the new sentence — the only part that matters —
 * is at the top of a wall the reader has already read. So bodies here are new
 * text only, and what was removed is counted rather than hidden silently.
 */

const QUOTE_MARKERS: RegExp[] = [
  // "On Friday, 7 August 2026 at 10:57, Sadanand Palekar wrote:"
  /^\s*On\b[\s\S]{0,200}?\bwrote:\s*$/,
  // Outlook's divider, in the several shapes it ships in.
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*From:\s*.+$/,
  // Apple Mail / mobile clients.
  /^\s*Begin forwarded message:\s*$/i,
  /^\s*Sent from my \w+/i,
];

/** A line that is quoted history rather than something newly written. */
function isQuoteBoundary(line: string): boolean {
  return QUOTE_MARKERS.some((marker) => marker.test(line));
}

export type StrippedBody = {
  /** Only what this sender newly wrote. */
  text: string;
  /** How many earlier messages were quoted underneath it. */
  quotedCount: number;
};

/**
 * Split a body into what was newly written and what was quoted beneath it.
 *
 * The count is of quoted MESSAGES, not quoted lines: "4 quoted messages hidden"
 * tells the reader how much history is under the fold, which is the thing they
 * would otherwise scroll to check.
 */
export function stripQuoted(body: string): StrippedBody {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const fresh: string[] = [];
  let quotedCount = 0;
  let inQuote = false;
  // Outlook writes a divider and a "From:" header block back to back; both are
  // boundaries but they open one quoted message, not two.
  let previousWasBoundary = false;

  for (const line of lines) {
    if (isQuoteBoundary(line)) {
      // Each "On … wrote:" opens another quoted message, which is what makes
      // the count the depth of the history rather than a flag.
      if (!previousWasBoundary) quotedCount += 1;
      inQuote = true;
      previousWasBoundary = true;
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (!inQuote) quotedCount += 1;
      inQuote = true;
      previousWasBoundary = false;
      continue;
    }
    if (line.trim() !== "") previousWasBoundary = false;
    // A blank line inside quoted history does not end it; real text does.
    if (inQuote) {
      if (line.trim() === "") continue;
      // Text after a quote block is usually a signature or a top-post reply
      // to the block below; treat it as quoted so the fresh text stays clean.
      continue;
    }
    fresh.push(line);
  }

  return { text: fresh.join("\n").trim(), quotedCount };
}

/** The readable, newly-written body of one message. */
export function freshBody(message: Message): StrippedBody {
  const stripped = stripQuoted(readableBody(message));
  // A message that is nothing but a quote still said something by existing —
  // fall back to the snippet rather than rendering an empty turn.
  if (!stripped.text) {
    return { text: message.snippet?.trim() ?? "", quotedCount: stripped.quotedCount };
  }
  return stripped;
}

const domainOf = (email: string | null | undefined) =>
  (email ?? "").split("@")[1]?.toLowerCase().trim() ?? "";

/**
 * A message is internal when nobody outside the user's own company is on it.
 * That is the forward to a colleague and every reply it drew — the branch.
 */
export function isInternal(message: Message, ownDomain: string): boolean {
  const own = ownDomain.toLowerCase().trim();
  if (!own) return false;
  const recipients = [...message.to, ...message.cc];
  if (recipients.length === 0) return false;
  const everyone = [message.from, ...recipients];
  return everyone.every((address) => domainOf(address.email) === own);
}

export const displayName = (address: Address): string =>
  address.name?.trim() || address.email?.split("@")[0] || "Unknown";

export type Turn = {
  kind: "turn";
  message: Message;
  who: string;
  isYou: boolean;
  peek: string;
  body: string;
  quotedCount: number;
};

export type Branch = {
  kind: "branch";
  /** Who the work was handed to. */
  to: string;
  at: string;
  turns: {
    message: Message;
    who: string;
    isYou: boolean;
    text: string;
  }[];
};

export type Lane = Turn | Branch;

/** The first line of a body, for the collapsed row. */
function peekOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim();
}

/**
 * Group a conversation into the external trunk and the internal branches that
 * hang off it. Consecutive internal messages form one branch, because that is
 * how they happen: one forward, then the thread it started.
 */
export function shapeThread(
  conversation: Conversation,
  ownDomain: string,
  ownEmail?: string | null,
): Lane[] {
  const own = (ownEmail ?? "").toLowerCase().trim();
  const isYou = (message: Message) =>
    message.isOutgoing ||
    (own.length > 0 && message.from.email?.toLowerCase().trim() === own);

  const lanes: Lane[] = [];
  for (const message of conversation.messages) {
    const who = isYou(message) ? "You" : displayName(message.from);
    if (isInternal(message, ownDomain)) {
      const previous = lanes[lanes.length - 1];
      const stripped = freshBody(message);
      const turn = { message, who, isYou: isYou(message), text: stripped.text };
      if (previous && previous.kind === "branch") {
        previous.turns.push(turn);
        continue;
      }
      const recipients = [...message.to, ...message.cc].filter(
        (address) => address.email?.toLowerCase().trim() !== own,
      );
      lanes.push({
        kind: "branch",
        to: recipients.map(displayName).join(", ") || "the team",
        at: message.sentAt,
        turns: [turn],
      });
      continue;
    }
    const stripped = freshBody(message);
    lanes.push({
      kind: "turn",
      message,
      who,
      isYou: isYou(message),
      peek: peekOf(stripped.text),
      body: stripped.text,
      quotedCount: stripped.quotedCount,
    });
  }
  return lanes;
}

export type ConversationFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** How many times this name was attached — a revised document, usually. */
  versions: number;
  /** The most recent attachment carrying this name. */
  attachmentId: string;
  messageId: string;
};

/**
 * Every file on the thread, once. Hunting turn by turn for the latest version
 * of a document is one of the things a thread makes people do.
 */
export function conversationFiles(conversation: Conversation): ConversationFile[] {
  const byName = new Map<string, ConversationFile>();
  for (const message of conversation.messages) {
    for (const attachment of message.attachments) {
      const key = attachment.filename.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.versions += 1;
        // Later messages carry the newer copy.
        existing.attachmentId = attachment.id;
        existing.messageId = message.providerMessageId;
        existing.sizeBytes = attachment.sizeBytes;
        continue;
      }
      byName.set(key, {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        versions: 1,
        attachmentId: attachment.id,
        messageId: message.providerMessageId,
      });
    }
  }
  return [...byName.values()];
}

export type Participant = {
  name: string;
  email: string;
  /** The counterparty's company, or "internal" for the user's own domain. */
  org: string;
  isYou: boolean;
  /** On the thread early and off it now. */
  droppedOff: boolean;
};

/**
 * Who is on this, and who quietly stopped being on it. People fall off threads
 * without anyone noticing, and then a reply goes to someone who left the
 * company three weeks ago.
 */
export function participants(
  conversation: Conversation,
  ownDomain: string,
  ownEmail?: string | null,
): Participant[] {
  const own = (ownEmail ?? "").toLowerCase().trim();
  const ownDom = ownDomain.toLowerCase().trim();
  const seen = new Map<string, Participant>();
  const lastSeen = new Map<string, number>();

  conversation.messages.forEach((message, index) => {
    for (const address of [message.from, ...message.to, ...message.cc]) {
      const email = address.email?.toLowerCase().trim();
      if (!email) continue;
      lastSeen.set(email, index);
      if (seen.has(email)) continue;
      const domain = domainOf(email);
      seen.set(email, {
        name: email === own ? "You" : displayName(address),
        email,
        org: domain === ownDom ? "internal" : domain.split(".")[0] ?? "",
        isYou: email === own,
        droppedOff: false,
      });
    }
  });

  // "Recent" is the last third of the thread, which is long enough that one
  // missed cc does not read as someone leaving.
  const total = conversation.messages.length;
  const recentFrom = Math.max(0, total - Math.max(1, Math.ceil(total / 3)));
  for (const [email, person] of seen) {
    person.droppedOff = total > 2 && (lastSeen.get(email) ?? 0) < recentFrom;
  }
  return [...seen.values()];
}

export type ThreadSummary = {
  external: number;
  internal: number;
  people: number;
  /** Days since the counterparty last wrote and got no external answer. */
  daysUnanswered: number | null;
  /** The counterparty waiting on a reply, if one is. */
  waitingOn: string | null;
};

export function summariseThread(
  conversation: Conversation,
  ownDomain: string,
  ownEmail?: string | null,
  now = Date.now(),
): ThreadSummary {
  const lanes = shapeThread(conversation, ownDomain, ownEmail);
  const external = lanes.filter((lane) => lane.kind === "turn").length;
  const internal = lanes
    .filter((lane): lane is Branch => lane.kind === "branch")
    .reduce((n, branch) => n + branch.turns.length, 0);

  // Walk the trunk backwards: if the last external turn came from outside, the
  // counterparty is still waiting.
  let daysUnanswered: number | null = null;
  let waitingOn: string | null = null;
  for (let i = lanes.length - 1; i >= 0; i -= 1) {
    const lane = lanes[i];
    if (lane.kind !== "turn") continue;
    if (!lane.isYou) {
      const at = Date.parse(lane.message.sentAt);
      if (!Number.isNaN(at)) {
        daysUnanswered = Math.max(0, Math.floor((now - at) / 86_400_000));
        waitingOn = lane.who;
      }
    }
    break;
  }

  return {
    external,
    internal,
    people: participants(conversation, ownDomain, ownEmail).length,
    daysUnanswered,
    waitingOn,
  };
}
