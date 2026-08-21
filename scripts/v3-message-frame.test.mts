/**
 * The message frame reads like a message, not a scrolling box inside a page.
 * It sizes itself to its content and shrinks wide mail to the screen the way
 * Gmail and Outlook do — while staying an opaque-origin sandbox, which is the
 * part that must never regress.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync(
  new URL("../src/components/v2/MessageHtml.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);

// --- fits the screen --------------------------------------------------------

assert.match(
  component,
  /width=device-width/,
  "the frame must lay out against the device width, not a desktop default",
);
assert.match(
  component,
  /max-width:\s*100%/,
  "images and tables must be capped to the frame",
);
assert.match(
  component,
  /scale\(/,
  "mail too wide to reflow must be scaled down rather than clipped",
);

// --- grows to its content ---------------------------------------------------

assert.match(component, /seerFrameHeight/, "the frame reports its own height");
assert.match(
  component,
  /ResizeObserver/,
  "late-loading images change the height after first paint",
);

const frameRule = styles.slice(
  styles.indexOf(".seer-message-frame"),
  styles.indexOf("}", styles.indexOf(".seer-message-frame")),
);
assert.doesNotMatch(
  frameRule,
  /min-height:\s*22rem/,
  "a fixed 22rem frame is the box this replaces",
);

const bodyRule = styles.slice(
  styles.indexOf(".seer-message-body"),
  styles.indexOf("}", styles.indexOf(".seer-message-body")),
);
assert.doesNotMatch(
  bodyRule,
  /overflow-x:\s*auto/,
  "the page scrolls, not a rail inside the message",
);

// --- still sandboxed --------------------------------------------------------

assert.match(component, /sandbox=/);
assert.doesNotMatch(
  component,
  /allow-same-origin/,
  "the frame must stay on an opaque origin: it may never reach the app's DOM, cookies or storage",
);
assert.doesNotMatch(component, /allow-forms/, "message HTML may not submit forms");
assert.doesNotMatch(
  component,
  /allow-top-navigation/,
  "a message may not navigate the app away",
);
assert.match(
  component,
  /event\.source !== /,
  "height messages are only trusted from this frame's own window",
);
assert.doesNotMatch(component, /dangerouslySetInnerHTML/);

console.log("v3-message-frame: OK");
