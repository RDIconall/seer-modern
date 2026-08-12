import type { Command, CommandResult } from "@/lib/v2/commands/types";

export type ComposeMode = "send" | "reply" | "replyAll" | "forward";

/** A forward and a new message address someone; a reply already knows who. */
export function needsRecipient(mode: ComposeMode): boolean {
  return mode === "send" || mode === "forward";
}

/**
 * Passing a thread on without adding a word is an ordinary thing to do, so a
 * forward must not be held back for an empty comment box the way the old
 * compose did. An empty reply, on the other hand, says nothing to anyone.
 */
export function needsBody(mode: ComposeMode): boolean {
  return mode === "reply" || mode === "replyAll";
}

export function canSendCompose(input: {
  mode: ComposeMode;
  recipientCount: number;
  body: string;
  sending: boolean;
}): boolean {
  if (input.sending) return false;
  if (needsRecipient(input.mode) && input.recipientCount === 0) return false;
  if (needsBody(input.mode) && input.body.trim().length === 0) return false;
  return true;
}

/** Dispatch one command to the v2 command bus with a fresh idempotency key. */
export async function dispatchCommand(command: Command): Promise<CommandResult> {
  const res = await fetch("/api/v2/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      idempotencyKey:
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
  });
  const json = (await res.json()) as { result: CommandResult };
  if (!res.ok || !json.result.ok) {
    throw new Error(json.result?.error ?? `command ${res.status}`);
  }
  return json.result;
}
