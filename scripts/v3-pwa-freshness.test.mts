/**
 * Gate: the installed app cannot pin itself to an old build.
 *
 * The service worker used to cache the shell HTML and serve it whenever a
 * navigation fetch failed — routine when an installed iOS app is resumed — while
 * `/_next/static` was cache-first under a cache name that never changed. The
 * stale shell's old chunks were therefore still there to serve it, and the app
 * booted entirely on old code while looking perfectly normal. Every deploy
 * appeared not to have happened.
 *
 * This is worse than having no worker at all, so it is worth a test.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

const swSource = await fs.readFile("public/sw.js", "utf8");
// The comments explain the bug this guards against, so they name the very
// things the assertions forbid. Judge the code.
const sw = swSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const register = await fs.readFile("src/components/PwaRegister.tsx", "utf8");

// The shell is never precached, so there is nothing stale to fall back to.
const precache = /const PRECACHE = \[([\s\S]*?)\]/.exec(sw)?.[1] ?? "";
assert.ok(precache.length > 0, "expected a precache list to inspect");
assert.doesNotMatch(precache, /"\/m"/, "the app shell must not be precached");

// And the application code is never served from the worker's cache, so a shell
// and a chunk can never come from different builds.
assert.doesNotMatch(
  sw,
  /_next\/static/,
  "hashed chunks belong to the HTTP cache, not to the worker",
);
assert.doesNotMatch(
  sw,
  /caches\.match\("\/m"\)/,
  "a failed navigation must not resurrect an old shell",
);

// Renaming the cache is what evicts the bad state from installs already out
// there, so the name must have moved past the one that carried it.
const cacheName = /const CACHE = "([^"]+)"/.exec(sw)?.[1];
assert.ok(cacheName, "the worker must name its cache");
assert.notEqual(cacheName, "seer-mobile-v2", "the poisoned cache name must be retired");
assert.match(register, new RegExp(cacheName!), "the page must purge all but the current cache");

// A resumed app does not navigate, so something has to ask whether there is
// newer code, and act on the answer.
assert.match(
  register,
  /visibilitychange/,
  "coming back to the foreground must check for a new build",
);
assert.match(register, /registration\?\.update\(\)|\.update\(\)/);
assert.match(
  register,
  /controllerchange/,
  "a new worker taking control must be noticed",
);
assert.match(register, /location\.reload\(\)/);
// Guarded, because a reload loop is worse than a stale app.
assert.match(register, /if \(reloading\) return/);

console.log("v3-pwa-freshness: OK");
