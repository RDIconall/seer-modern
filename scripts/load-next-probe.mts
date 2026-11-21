/**
 * Next's request AsyncLocalStorage cannot be constructed from this test runner:
 * tsx follows the published source maps into the edge build, which throws.
 * The handlers read the incoming request through `headers()` and `cookies()`,
 * and those functions return the request values unchanged aside from sealing
 * them. This shim installs the same two functions on the loaded `next/headers`
 * exports before any route is imported, and feeds them the request under test.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextHeaders = require(path.join(root, "node_modules/next/headers.js"));

let current = new Headers();
const pending: Promise<unknown>[] = [];

nextHeaders.headers = function headers() {
  const bag = current;
  return Promise.resolve({
    get: (name: string) => bag.get(name),
    has: (name: string) => bag.has(name),
  });
};

nextHeaders.cookies = function cookies() {
  const pairs = new Map<string, string>();
  const raw = current.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    pairs.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return Promise.resolve({
    get(name: string) {
      const value = pairs.get(name);
      return value === undefined ? undefined : { name, value };
    },
  });
};

let serverExports: { after?: (task: unknown) => void } | null = null;
try {
  serverExports = require(path.join(root, "node_modules/next/server.js"));
  serverExports!.after = (task: unknown) => {
    pending.push(
      Promise.resolve(typeof task === "function" ? (task as () => unknown)() : task),
    );
  };
} catch {
  serverExports = null;
}

export function setRequestHeaders(headers: Headers) {
  current = headers;
}

export async function drainAfter() {
  const queued = pending.splice(0, pending.length);
  await Promise.all(queued);
}
