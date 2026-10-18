/**
 * Mail mutations that talk to Gmail/Graph must load a provider on the
 * command bus. Move was missing from that list, so the reader Move
 * action always failed closed with "provider unavailable".
 */
import assert from "node:assert/strict";
import { needsProvider } from "../src/lib/v2/commands/needs-provider.ts";
import type { Command } from "../src/lib/v2/commands/types.ts";

const providerTypes: Command["type"][] = [
  "send",
  "reply",
  "forward",
  "move",
  "decideTriageProposal",
];

for (const type of providerTypes) {
  assert.equal(
    needsProvider({ type } as Command),
    true,
    `${type} must load a mail provider`,
  );
}

assert.equal(needsProvider({ type: "archive" } as Command), false);
assert.equal(needsProvider({ type: "delete" } as Command), false);
assert.equal(needsProvider({ type: "createBotTask" } as Command), false);

console.log("v2-needs-provider: OK");
