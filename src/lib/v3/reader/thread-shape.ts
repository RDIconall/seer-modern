import type { Address, Conversation, Message } from "@/lib/v2/providers/types";
import { htmlToText, readableBody } from "@/lib/v2/intelligence/html-text";
import { quotedHtmlTail, readableHtml } from "@/lib/v3/reader/email-html";

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

export type StrippedText = {
  /** Only what this sender newly wrote. */
  text: string;
  /** How many earlier messages were quoted underneath it. */
  quotedCount: number;
  /** Everything cut away from `text`, as text. */
  quoted: string;
};

export type StrippedBody = StrippedText & {
  /**
   * The same new text as HTML, structure kept and theme-safe. Null when the
   * message had no usable HTML body — the reader then falls back to `text`.
   */
  html: string | null;
  /** The markup cut away from `html`; `quoted` is the cut from the text. */
  quotedHtml: string;
};

/**
 * Split a body into what was newly written and what was quoted beneath it.
 *
 * The count is of quoted MESSAGES, not quoted lines: "4 quoted messages hidden"
 * tells the reader how much history is under the fold, which is the thing they
 * would otherwise scroll to check.
 */
export function stripQuoted(body: string): StrippedText {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const fresh: string[] = [];
  const quoted: string[] = [];
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
      quoted.push(line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (!inQuote) quotedCount += 1;
      inQuote = true;
      previousWasBoundary = false;
      quoted.push(line);
      continue;
    }
    if (line.trim() !== "") previousWasBoundary = false;
    // A blank line inside quoted history does not end it; real text does.
    if (inQuote) {
      if (line.trim() === "") continue;
      // Text after a quote block is usually a signature or a top-post reply
      // to the block below; treat it as quoted so the fresh text stays clean.
      quoted.push(line);
      continue;
    }
    fresh.push(line);
  }

  return {
    text: fresh.join("\n").trim(),
    quotedCount,
    quoted: quoted.join("\n").trim(),
  };
}

type BodyParts = Pick<Message, "bodyHtml" | "bodyText" | "snippet">;

/** The readable, newly-written body of one message. */
export function freshBody(message: BodyParts): StrippedBody {
  const stripped = stripQuoted(readableBody(message));
  const htmlPart = readableHtml(message.bodyHtml);
  // Prefer the HTML quote count when a body was HTML: Outlook and Gmail mark
  // quote boundaries in markup that the plain-text heuristics miss.
  const quotedCount = message.bodyHtml ? htmlPart.quotedCount : stripped.quotedCount;
  // When the body was HTML, the markup is where the boundary really is, so the
  // text comes from the already-stripped markup. Otherwise the one-line peek
  // and the rendered body can disagree — the peek cut by a "From:" line in a
  // signature that the rendered body still shows in full.
  const fromHtml = htmlPart.html ? htmlToText(htmlPart.html).trim() : "";
  // A message that is nothing but a quote still said something by existing —
  // fall back to the snippet rather than rendering an empty turn.
  const text = fromHtml || stripped.text || (message.snippet?.trim() ?? "");
  return {
    text,
    html: htmlPart.html || null,
    quotedCount,
    quoted: stripped.quoted,
    quotedHtml: htmlPart.quotedCount > 0 ? quotedHtmlTail(message.bodyHtml) : "",
  };
}

/**
 * What the reader has already been shown of a conversation: the messages above
 * the one being opened, and the names, addresses and subject on them.
 */
export type ThreadHistory = {
  passages: string[];
  words: Set<string>;
};

const normalise = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Words a client writes into an attribution or header block ("On Fri, 8 Aug
 * 2026 at 10:57, Pat wrote:", "From: … Sent: … Subject: …") beyond the names,
 * addresses and subject already on the thread.
 */
const HEADER_WORDS = new Set(
  (
    "on at wrote said from sent date to cc bcc subject re fw fwd aw sv reply " +
    "original message forwarded begin of behalf my iphone ipad android phone " +
    "mobile device outlook ios mail gmail for am pm utc gmt bst cet cest est " +
    "edt cst cdt pst pdt ist mailto " +
    "january february march april may june july august september october " +
    "november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "mon tue tues wed thu thur thurs fri sat sun"
  ).split(" "),
);

export function startHistory(subject: string): ThreadHistory {
  return { passages: [], words: new Set(normalise(subject).split(" ")) };
}

/**
 * Add one message the reader can open to the history later messages are
 * checked against. Only what the pane renders for it counts: its HTML when it
 * has some, otherwise its text.
 */
export function addToHistory(
  history: ThreadHistory,
  message: BodyParts,
  people: ReadonlyArray<string | null | undefined>,
): void {
  const passage = normalise(
    message.bodyHtml ? htmlToText(message.bodyHtml) : readableBody(message),
  );
  if (passage) history.passages.push(` ${passage} `);
  for (const person of people) {
    for (const word of normalise(person ?? "").split(" ")) {
      if (word) history.words.add(word);
    }
  }
}

/** An Outlook header block or a wrapped attribution, with room to spare. */
const MAX_HEADER_LINES = 8;

const isHeaderLine = (line: string, history: ThreadHistory) =>
  line
    .split(" ")
    .every(
      (word) =>
        history.words.has(word) ||
        HEADER_WORDS.has(word) ||
        /^\d{1,4}(?:st|nd|rd|th)?$/.test(word),
    );

/**
 * Is `quoted` a copy of something the reader can already open further up the
 * thread? Real quoted history is a short attribution or header block made of
 * the thread's own names, addresses, subject and date words, then one
 * unbroken run of an earlier message. Anything added to, inserted into, or
 * standing in for that run is new text from this sender.
 */
export function repeatsHistory(quoted: string, history: ThreadHistory): boolean {
  const lines = quoted.split("\n").map(normalise).filter(Boolean);
  let start = 0;
  while (
    start < lines.length &&
    start < MAX_HEADER_LINES &&
    isHeaderLine(lines[start], history)
  ) {
    start += 1;
  }
  const rest = lines.slice(start).join(" ");
  if (!rest) return true;
  return history.passages.some((passage) => passage.includes(` ${rest} `));
}

export type ShownBody = {
  /** What the opened turn shows: new text when the quote is folded, else all of it. */
  text: string;
  /** `text` as HTML: the stripped markup when folded, else the whole body. */
  html: string | null;
  /** Quoted messages folded under the turn; 0 when nothing is folded. */
  quotedCount: number;
  /** The whole message as received, for the control that reveals the fold. */
  fullText: string;
  /** The first line of new text, for the collapsed row. */
  peek: string;
};

/**
 * Decide what one opened message shows. A quote marker is something any sender
 * can write, so the history under it is only folded when it repeats what the
 * thread already shows; otherwise the whole message is the body.
 */
export function shownBody(message: BodyParts, history: ThreadHistory): ShownBody {
  const stripped = freshBody(message);
  const fullText = readableBody(message) || stripped.text;
  // Either cut can supply `text`, so both must be history before either folds.
  const folded =
    stripped.quotedCount > 0 &&
    repeatsHistory(htmlToText(stripped.quotedHtml), history) &&
    repeatsHistory(stripped.quoted, history);
  return {
    text: folded ? stripped.text : fullText,
    html: folded ? stripped.html : message.bodyHtml ?? null,
    quotedCount: folded ? stripped.quotedCount : 0,
    fullText,
    peek: peekOf(stripped.text || fullText),
  };
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
  bodyHtml: string | null;
  quotedCount: number;
  fullText: string;
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
    html: string | null;
    quotedCount: number;
    fullText: string;
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
  const history = startHistory(conversation.subject);
  for (const message of conversation.messages) {
    const who = isYou(message) ? "You" : displayName(message.from);
    const shown = shownBody(message, history);
    addToHistory(
      history,
      message,
      [message.from, ...message.to, ...message.cc].flatMap((address) => [
        address.name,
        address.email,
      ]),
    );
    if (isInternal(message, ownDomain)) {
      const previous = lanes[lanes.length - 1];
      const turn = {
        message,
        who,
        isYou: isYou(message),
        text: shown.text,
        html: shown.html,
        quotedCount: shown.quotedCount,
        fullText: shown.fullText,
      };
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
    lanes.push({
      kind: "turn",
      message,
      who,
      isYou: isYou(message),
      peek: shown.peek,
      body: shown.text,
      bodyHtml: shown.html,
      quotedCount: shown.quotedCount,
      fullText: shown.fullText,
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
