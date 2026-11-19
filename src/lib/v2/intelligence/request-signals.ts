import type { Conversation } from "../providers/types";
import { conversationPayload } from "./model";

/**
 * What the message itself asks of the user, found in code.
 *
 * Delete safety used to take "is there an open ask / a pending obligation"
 * from the same read that proposed the delete. That read is shown the body,
 * and the body is written by whoever sent the mail, so one sentence telling
 * the model to report "owner nobody, ask nothing, obligation false" cleared a
 * real request for the trash. These signals are computed from exactly the
 * text the model is given and cannot be talked out of a veto.
 *
 * Like `isHumanCorrespondence`, this errs toward keeping mail. A false
 * positive archives a disposable email (reversible); a false negative lets a
 * real request reach the delete pile.
 */

export type RequestSignals = {
  /** The text asks the user to reply, confirm, send, review, and so on. */
  openAsk: boolean;
  /** A signature, approval, or payment step is named. */
  pendingObligation: boolean;
  /** The text addresses the classifier or dictates its output fields. */
  addressesClassifier: boolean;
};

/** Cyrillic and Greek letters that render like Latin ones. */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0501": "d", "\u04bb": "h", "\u04cf": "l", "\u0261": "g", "\u0578": "n",
  "\u03b1": "a", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t", "\u03b9": "i",
  "\u03ba": "k", "\u03bd": "v",
};

/**
 * Lowercase ASCII words separated by single spaces. Strips diacritics,
 * zero-width and bidi characters, folds look-alike letters, and rejoins
 * letter-spaced words ("s i g n", "s.i.g.n") so trivial disguises a model
 * still reads do not slip past a phrase match.
 */
export function normaliseSignalText(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (ch) => CONFUSABLES[ch] ?? " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return folded.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ""));
}

const ASK_PATTERNS: RegExp[] = [
  /\bcould you\b/,
  /\b(can|would|will) you (please|kindly)\b/,
  /\bwould you mind\b/,
  /\bkindly\b/,
  /\bplease (?:(?:kindly|just|also|now|promptly|urgently|quickly|immediately|asap) )?(reply|respond|confirm|review|send|sign|countersign|approve|pay|advise|provide|complete|return|submit|forward|get back|call|schedule|acknowledge|accept|remit|transfer|wire|process|execute)\b/,
  /\bget back to (me|us)\b/,
  /\b(waiting|awaiting|wait)( on| for)? your (reply|answer|response|approval|signature|confirmation|decision|feedback|input|go ahead|sign off)\b/,
  /\b(need|needs|require|requires|required|requesting|request) your (reply|answer|response|approval|signature|confirmation|decision|input|go ahead|sign off)\b/,
  /\b(we|i) need you to\b/,
  /\byour (reply|response|answer|approval|signature|confirmation|decision|input|sign off) (is )?(required|needed|requested|pending|outstanding)\b/,
  /\b(can|could|would|will) you (send|confirm|review|sign|countersign|approve|pay|reply|respond|call|provide|forward|return|submit|complete|schedule|advise|execute|transfer|wire|release|get back|let me know)\b/,
  /\bneed (a |an |your )?(yes|answer|reply|response|decision|go ahead|sign off|approval|confirmation) from you\b/,
  /\blet me know\b/,
  /\b(action|response|reply|signature|approval|payment) (is )?(required|needed|requested)\b/,
  /\b(respond|reply|confirm) (by|before|no later than)\b/,
];

const OBLIGATION_PATTERNS: RegExp[] = [
  /\bcounter ?sign/,
  /\bsignature\b/,
  /\bsign (the|this|and return|here|off|the attached)\b/,
  /\bdocusign\b/,
  /\bapprov(e|al|als)\b/,
  /\bwire (payment|transfer|instructions)\b/,
  /\bpayment (is |was )?(due|overdue|required|pending|outstanding)\b/,
  /\b(past due|overdue) (invoice|payment|balance|amount)\b/,
  /\bremit\b/,
  /\be ?sign(ature|ed|ing)?\b/,
  /\bexecute (the|this|our|your) (agreement|contract|document|amendment|nda|sow|order)\b/,
  /\b(transfer|send|release) (the )?(funds|payment|money)\b/,
  /\bpay (the|this|our|my) (invoice|bill|balance|amount|fee)\b/,
  /\binvoice (is )?(due|overdue|outstanding|unpaid)\b/,
];

/**
 * Markup can split a word the model still reads as one ("coun<b>ter</b>sign"
 * arrives as "coun ter sign"). These are matched with every space removed.
 */
const COMPACT_ASK = [
  "couldyou",
  "pleasereply",
  "pleaserespond",
  "pleaseconfirm",
  "pleasereview",
  "pleasesend",
  "pleasepay",
  "waitingonyour",
  "awaitingyour",
];
const COMPACT_OBLIGATION = [
  "countersign",
  "signature",
  "pleasesign",
  "pleaseapprove",
  "yourapproval",
  "approvalrequired",
  "wirepayment",
  "wiretransfer",
];

const FIELD = "(home|owner|ask|obligation|yields?)";

const CLASSIFIER_PATTERNS: RegExp[] = [
  new RegExp(`\\b(set|mark|classify|label|treat|categori[sz]e|output) (the )?${FIELD} (field |value )?(to|as|of|be|is)\\b`),
  /\b(home|owner|obligation)( to| as| is| be)? (delete|nobody|false)\b/,
  /\bask( to| as| is| be)? nothing informational\b/,
  /\bnothing informational\b/,
  /\byields?( to| as| is| be)? (empty|none|an empty)\b/,
  /\bignore (all |any )?(the |your )?(previous|prior|above|earlier|preceding|other|system) (instructions?|rules|prompts?|directions|guidance)\b/,
  /\bsystem prompt\b/,
  /\b(instructions?|note|message|directive|notice) (to|for) (the |any |all )?(ai|assistant|classifier|model|llm|bot|agent|reader|chief of staff|automated)\b/,
  /\b(to|for|attention) (any |all |the )?(ai|llm|language model|classifier|assistant) (reading|processing|triaging|sorting|classifying)\b/,
  /\bif you are an? (ai|llm|language model|assistant|classifier|bot)\b/,
  /\b(classify|mark|treat|file|label|categori[sz]e|tag|consider|record) (this|it|that|the) ((email|message|mail|thread|note|conversation) )?(\w+ ){0,2}as (\w+ ){0,2}(delete|deleted|deletable|disposable|spam|junk|safe to delete|informational|noise|no action|fyi|unimportant|trash|newsletter|promotional)\b/,
  /\b(ai|automated|llm|language model|bot|assistant|classifier|filter|triage|sorter|agent|chief of staff)\b( \w+){0,6} (mark|classify|treat|file|label|set|ignore|delete|archive|categori[sz]e|tag|consider|return|output|record)\b( \w+){0,6} (this|the|that) (email|message|mail|thread|note|conversation)\b/,
  /\b(ai|llm|assistant|classifier|bot|model|agent)( assistant| system| agent| model)? (note|notes|instruction|instructions|directive|directives)\b/,
];

/**
 * Every string the reader prompt carries for this conversation: subject,
 * addresses with display names, attachment names, and the readable body of
 * each message. Taken from `conversationPayload` so the check and the model
 * see the same text.
 */
function promptStrings(conversation: Conversation): string[] {
  const payload = conversationPayload(conversation);
  const out: string[] = [payload.subject ?? ""];
  for (const m of payload.messages) {
    out.push(m.from, ...m.to, ...m.cc, m.body);
    if ("attachments" in m && m.attachments) out.push(...m.attachments);
  }
  return out;
}

export function requestSignalsInText(texts: string[]): RequestSignals {
  let openAsk = false;
  let pendingObligation = false;
  let addressesClassifier = false;
  for (const raw of texts) {
    const spaced = normaliseSignalText(raw);
    if (!spaced) continue;
    const compact = spaced.replace(/ /g, "");
    openAsk ||=
      ASK_PATTERNS.some((p) => p.test(spaced)) ||
      COMPACT_ASK.some((w) => compact.includes(w));
    pendingObligation ||=
      OBLIGATION_PATTERNS.some((p) => p.test(spaced)) ||
      COMPACT_OBLIGATION.some((w) => compact.includes(w));
    addressesClassifier ||= CLASSIFIER_PATTERNS.some((p) => p.test(spaced));
  }
  return { openAsk, pendingObligation, addressesClassifier };
}

export function requestSignals(conversation: Conversation): RequestSignals {
  return requestSignalsInText(promptStrings(conversation));
}
