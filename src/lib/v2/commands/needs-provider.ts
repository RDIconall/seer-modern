import type { Command } from "./types";

/**
 * Commands that talk to Gmail/Graph must load a mail provider on the bus.
 * Move belongs here: the reader Move action calls provider.moveConversation.
 */
export function needsProvider(command: Command): boolean {
  return (
    command.type === "send" ||
    command.type === "reply" ||
    command.type === "forward" ||
    command.type === "move" ||
    command.type === "decideTriageProposal"
  );
}
