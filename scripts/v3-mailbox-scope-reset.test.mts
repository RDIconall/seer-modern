/**
 * Gate: the mailbox never mirrors its seed view into state.
 *
 * The hook used to re-assign four pieces of state from an effect whenever the
 * seed changed. The section alternates for a beat while the URL hash is
 * applied, so the scope alternated with it, the effect assigned on every run,
 * and React ended the client with "Maximum update depth exceeded" — which the
 * error boundary turned into a blank page with a "client-side exception".
 *
 * A result now belongs to exactly one scope and is read, not copied.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

const source = await fs.readFile("src/components/v3/useMailbox.ts", "utf8");

// The scope a result belongs to: account, folder, sort.
assert.match(source, /const scope = `\$\{accountId \?\? ""\}:\$\{folder\}:\$\{sort\}`/);

// Reading is derivation: a result from another scope is simply not this result.
assert.match(
  source,
  /loaded && loaded\.scope === scope\s*\?\s*loaded\s*:/,
  "a view from another scope must not be shown for this one",
);

// The four mirrored setters are gone. Their existence is the bug.
for (const setter of ["setView(", "setLoading(", "setRefreshing(", "setError("]) {
  assert.ok(
    !source.includes(setter),
    `${setter}) mirrors derived state back into state and can loop the client`,
  );
}

// No effect may assign the seed view, however it is keyed.
assert.doesNotMatch(
  source,
  /useEffect\(\(\) => \{[^}]*viewRef\.current = initial/,
  "resetting from an effect is what looped; the seed is derived instead",
);

// A late response must land on the scope it was fetched for, not the current one.
assert.match(source, /const forScope = /);
assert.match(source, /settle\(\s*\{[\s\S]*?\},\s*forScope,?\s*\)/);

// And no debug probe survives into the client.
assert.doesNotMatch(source, /scope-probe/);
assert.doesNotMatch(source, /console\.log/);

console.log("v3-mailbox-scope-reset: OK");
