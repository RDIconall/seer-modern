/**
 * Gate: the mailbox resets on a change of SCOPE, never on the identity of the
 * seed view.
 *
 * The reset effect assigns state every time it runs. Keyed on the seed object,
 * any render that produced a new seed scheduled another render, which produced
 * another seed: React reported "Maximum update depth exceeded" and the error
 * boundary replaced the entire client with a fault page. A blank app is the
 * most expensive bug there is, so the shape of this effect is worth pinning.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

const source = await fs.readFile("src/components/v3/useMailbox.ts", "utf8");

const effect = source.slice(
  source.indexOf("const scope ="),
  source.indexOf("const reload = useCallback"),
);
assert.ok(effect.length > 0, "the scope reset effect must exist");

// Scope is account + folder + sort, compared by value.
assert.match(effect, /const scope = `\$\{accountId \?\? ""\}:\$\{folder\}:\$\{sort\}`/);
assert.match(
  effect,
  /if \(appliedScope\.current === scope\) return;/,
  "an unchanged scope must not re-apply the seed, or the effect loops",
);
assert.match(effect, /appliedScope\.current = scope;/);

// And the guard has to come before any assignment, or it guards nothing.
const guardAt = effect.indexOf("appliedScope.current === scope");
const firstSet = effect.indexOf("setView(");
assert.ok(
  guardAt > 0 && guardAt < firstSet,
  "the scope guard must precede the state assignments",
);

// The dependency list must not reintroduce a per-render identity as the key.
const deps = effect.slice(effect.lastIndexOf("}, ["), effect.lastIndexOf("]"));
assert.match(deps, /scope/, "scope is what the reset is keyed on");

console.log("v3-mailbox-scope-reset: OK");
