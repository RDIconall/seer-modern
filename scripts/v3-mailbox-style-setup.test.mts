/**
 * Gate: the first-run train modal must unmount after save.
 *
 * "Save and train on Cards" used to only navigate. The overlay reads
 * `data.confirmed` from the load on mount, which stayed false, so the
 * dialog sat on the Cards deck and could not be dismissed.
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

const client = await readFile("src/components/v3/MailClient.tsx", "utf8");
const overlay = client.match(
  /<MailboxStyleSetup[\s\S]*?onTrain=\{[\s\S]*?\}/,
);
assert.ok(overlay, "MailClient mounts the overlay");
assert.match(
  overlay[0],
  /!result\?\.ok/,
  "a failed confirm must throw so the overlay stays and shows the error",
);
assert.match(overlay[0], /throw new Error/);

console.log("v3-mailbox-style-setup: OK");
