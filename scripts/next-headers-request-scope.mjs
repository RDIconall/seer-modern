/**
 * Stand-in for `next/headers` when the Auth.js route handlers are called
 * directly. Next.js stores the request cookie header in async local storage;
 * this module does the same so `cookies()` and `headers()` see the request
 * the test is currently dispatching. Account-link and session lookup both
 * read that header and no other request data.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const requestCookies = new AsyncLocalStorage();

function parse(header) {
  const map = new Map();
  if (!header) return map;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return map;
}

export async function cookies() {
  const map = parse(requestCookies.getStore() ?? "");
  return {
    get(name) {
      const value = map.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...map.entries()].map(([name, value]) => ({ name, value }));
    },
    has(name) {
      return map.has(name);
    },
    set() {},
    delete() {},
  };
}

export async function headers() {
  const cookie = requestCookies.getStore() ?? "";
  return new Headers({
    cookie,
    host: "127.0.0.1:3000",
    "x-forwarded-host": "127.0.0.1:3000",
    "x-forwarded-proto": "http",
  });
}

export async function draftMode() {
  return {
    isEnabled: false,
    enable() {},
    disable() {},
  };
}
