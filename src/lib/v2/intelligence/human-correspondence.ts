import type { Conversation } from "../providers/types";
import { readableBody } from "./html-text";

/**
 * Human correspondence — the mail a person sat down and wrote to you.
 *
 * The worst thing this system can do is bin a letter from someone who knows
 * you. A referral from a family friend, opening "Hi Conall, this is Rachel's
 * Dad", reached "Safe to delete" because nothing in the existing safety layer
 * had an opinion about it: the sender was not yet a saved contact, so
 * `known_sender` did not fire; the note asked a favour rather than raising an
 * obligation, so `open_ask` and `pending_obligation` did not fire either. Every
 * veto was about the *state of the work*, and none about the *kind of mail*.
 *
 * So this is deliberately not a classifier. It answers one narrow question —
 * did a person greet you by name — and it answers it in code, because a model
 * that is already wrong about the mail cannot be trusted to grade itself.
 *
 * It errs toward "human" on purpose. A false positive leaves mail sitting in
 * the inbox, which costs a moment; a false negative deletes a letter from a
 * friend, which costs the user's trust in everything else here.
 */

/**
 * Addresses nobody greets you from. Kept deliberately narrow: matching too
 * eagerly here would strip the protection from real people whose address
 * happens to read like a role.
 */
const MACHINE_LOCAL_PART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounce[sd]?|notification[s]?|noreply|auto[-_.]?(reply|confirm|responder)|donotreply)\b/i;

export function isMachineAddress(email: string | null | undefined): boolean {
  const local = (email ?? "").split("@")[0] ?? "";
  return MACHINE_LOCAL_PART.test(local.trim());
}

/**
 * Openings a person uses. "Dear" and "Hi" carry the same weight here — the
 * signal is the greeting plus the name, not the register.
 */
const SALUTATION =
  /(^|\n)\s*(hi|hey|hello|dear|good\s+(?:morning|afternoon|evening)|greetings)\b([^\n]{0,60})/gi;

/** Strip punctuation and case so "Conall," and "conall" compare equal. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The names the user answers to: the display name mail is addressed to, and the
 * local part of their own address. "conall@rditrials.com" yields "conall";
 * "Conall Arora" yields "conall" and "arora".
 */
export function ownNames(
  conversation: Conversation,
  ownEmail: string | null | undefined,
): string[] {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => {
    for (const part of normalise(value ?? "").split(" ")) {
      // Two letters is the shortest real name; one would match any initial.
      if (part.length >= 2) names.add(part);
    }
  };

  const own = (ownEmail ?? "").toLowerCase().trim();
  add(own.split("@")[0]?.replace(/[._-]+/g, " "));
  for (const message of conversation.messages) {
    for (const address of message.to) {
      if (own && address.email?.toLowerCase().trim() === own) add(address.name);
    }
  }
  return [...names];
}

/**
 * The greeting line, if the opening of this text greets one of `names`. Only
 * the first stretch is considered: a "Dear Sir" buried in a quoted footer is
 * not someone greeting you.
 */
export function personalGreeting(text: string, names: string[]): string | null {
  if (names.length === 0) return null;
  const opening = text.slice(0, 400);
  SALUTATION.lastIndex = 0;
  for (const match of opening.matchAll(SALUTATION)) {
    const addressed = normalise(match[3] ?? "");
    if (!addressed) continue;
    const words = addressed.split(" ");
    if (words.some((word) => names.includes(word))) {
      return `${match[2]}${match[3]}`.trim();
    }
  }
  return null;
}

/**
 * True when a person wrote to this user by name. Inbound mail only — a greeting
 * in something the user sent is their own handwriting, not correspondence owed
 * to them.
 */
export function isHumanCorrespondence(
  conversation: Conversation,
  ownEmail: string | null | undefined,
): boolean {
  const names = ownNames(conversation, ownEmail);
  if (names.length === 0) return false;
  return conversation.messages.some((message) => {
    if (message.isOutgoing) return false;
    if (isMachineAddress(message.from.email)) return false;
    return personalGreeting(readableBody(message), names) !== null;
  });
}
