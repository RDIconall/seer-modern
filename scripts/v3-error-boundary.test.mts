/**
 * A client fault must not blank the app.
 *
 * With no error boundary anywhere, one bad render replaced Seer with the
 * browser's own "Application error: a client-side exception has occurred",
 * which says nothing, recovers nothing, and leaves no way to report what
 * happened. The boundary keeps the shell, names the fault, and offers a way
 * back in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import * as errorModule from "../src/app/error.tsx";

// The loader double-wraps a "use client" module's default export, so unwrap
// until a component falls out rather than assuming one interop shape.
function componentOf(module: unknown): React.ComponentType<never> {
  let candidate = module as { default?: unknown };
  while (candidate && typeof candidate !== "function" && "default" in candidate) {
    candidate = candidate.default as { default?: unknown };
  }
  assert.equal(typeof candidate, "function", "expected a component export");
  return candidate as unknown as React.ComponentType<never>;
}

const AppError = componentOf(errorModule);

const boundary = renderToString(
  createElement(AppError as never, {
    error: Object.assign(new Error("thread shape exploded"), {
      digest: "abc123",
    }),
    reset: () => {},
  }),
);
assert.match(boundary, /Something in Seer stopped working/);
assert.match(
  boundary,
  /thread shape exploded/,
  "the message is the whole point: an unnamed fault cannot be reported",
);
assert.match(boundary, /abc123/, "the digest ties this to the server log");
assert.match(boundary, /Try again/);
assert.match(boundary, /Reload Seer/);

const global = readFileSync(
  new URL("../src/app/global-error.tsx", import.meta.url),
  "utf8",
);
assert.match(global, /<html/, "a root-layout fault renders its own document");
assert.match(global, /<body/);
assert.match(global, /Reload Seer/);

// Storage is a privilege, not a given: a browser with site data blocked throws
// on the property access itself, and that must never take the app down.
const client = readFileSync(
  new URL("../src/components/v3/MailClient.tsx", import.meta.url),
  "utf8",
);
for (const call of [...client.matchAll(/window\.localStorage/g)]) {
  const line = client.slice(0, call.index).split("\n").length;
  const context = client.slice(Math.max(0, call.index - 400), call.index);
  assert.match(
    context,
    /try \{/,
    `window.localStorage at line ${line} must be guarded`,
  );
}

console.log("v3-error-boundary: OK");
