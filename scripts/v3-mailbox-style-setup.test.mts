/**
 * Gate: the first-run style overlay must unmount after save, and it must
 * send a large mailbox to Triage — not Cards.
 *
 * Cards is one-thread training. On a never-archive Inbox that is hundreds
 * of live threads; the overlay used to dump the user there and leave itself
 * up. Triage is the classified pile that can actually be cleared.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyConfirmedMailboxStyle,
  mailboxStyleOverlayOpen,
} from "../src/components/v3/mailbox-style-setup.ts";

const unconfirmed = { confirmed: false, driftPrompt: null as string | null };

assert.equal(
  mailboxStyleOverlayOpen({ data: unconfirmed, error: null }),
  true,
  "an unconfirmed mailbox still needs the first-run overlay",
);

assert.equal(
  mailboxStyleOverlayOpen({ data: null, error: null }),
  false,
  "do not flash an empty dialog while style is loading",
);

assert.equal(
  mailboxStyleOverlayOpen({ data: null, error: "Unable to load" }),
  true,
  "a load failure still needs the dialog so the error is visible",
);

assert.equal(
  mailboxStyleOverlayOpen({
    data: { confirmed: true, driftPrompt: null },
    error: null,
  }),
  false,
  "a confirmed style with no drift must not keep the overlay",
);

assert.equal(
  mailboxStyleOverlayOpen({
    data: { confirmed: true, driftPrompt: "Your clearing habit looks different." },
    error: null,
  }),
  true,
  "drift asks again; it does not silently hide",
);

assert.equal(
  mailboxStyleOverlayOpen({
    data: { confirmed: true, driftPrompt: null },
    error: null,
    force: true,
  }),
  true,
  "Settings re-opens the same flow with force; the parent unmounts it",
);

const saved = applyConfirmedMailboxStyle(unconfirmed);
assert.equal(saved.confirmed, true);
assert.equal(saved.driftPrompt, null);
assert.equal(
  mailboxStyleOverlayOpen({ data: saved, error: null }),
  false,
  "a successful save must hide the overlay without waiting for a refetch",
);
assert.equal(
  mailboxStyleOverlayOpen({ data: saved, error: null, force: true }),
  true,
  "force stays up until Settings closes it",
);

const setup = await readFile("src/components/v3/MailboxStyleSetup.tsx", "utf8");
assert.match(
  setup,
  /applyConfirmedMailboxStyle/,
  "confirm must mark the loaded style confirmed so the overlay can unmount",
);
assert.match(
  setup,
  /mailboxStyleOverlayOpen/,
  "overlay visibility must use the shared dismiss rule",
);

assert.match(
  setup,
  /Save and open Triage/,
  "confirm continues into Triage, the pile that can clear a large mailbox",
);
assert.doesNotMatch(
  setup,
  /[Tt]rain on Cards/,
  "Cards one-by-one training is not the first-run path",
);
assert.match(
  setup,
  /Triage[\s\S]{0,80}clear/,
  "the map must say Triage is where mail is cleared",
);
assert.doesNotMatch(
  setup,
  /Cards[\s\S]{0,40}still relevant/,
  "do not sell Cards as the training question in first-run",
);
assert.doesNotMatch(setup, /Train again/);
assert.match(
  setup,
  /#section=triage/,
  "Settings continue must open Triage, not Cards",
);

const client = await readFile("src/components/v3/MailClient.tsx", "utf8");
const overlay = client.match(
  /<MailboxStyleSetup[\s\S]*?onContinue=\{[\s\S]*?\}/,
);
assert.ok(overlay, "MailClient mounts the overlay");
assert.match(
  overlay[0],
  /!result\?\.ok/,
  "a failed confirm must throw so the overlay stays and shows the error",
);
assert.match(overlay[0], /throw new Error/);
assert.match(
  overlay[0],
  /navigate\(["']triage["']\)/,
  "save continues to Triage, not the Cards deck",
);
assert.doesNotMatch(overlay[0], /navigate\(["']cards["']\)/);

console.log("v3-mailbox-style-setup: OK");
