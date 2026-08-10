import type { ProviderKind } from "../providers/types";

/**
 * Which conversation actions Seer performs itself versus deferring to the
 * provider's web app. Seer only renders a button for what it can do safely and
 * completely on both providers; anything else routes to the exact native
 * conversation. A partially-working button is never shown.
 */

export type ClientAction =
  | "reply"
  | "replyAll"
  | "forward"
  | "archive"
  | "delete"
  | "restore"
  | "markUnread";

const SUPPORTED: ClientAction[] = [
  "reply",
  "replyAll",
  "forward",
  "archive",
  "delete",
  "restore",
  "markUnread",
];

/** Actions Seer handles in-app for this provider (parity: same for both). */
export function supportedActions(_provider: ProviderKind): ClientAction[] {
  void _provider;
  return [...SUPPORTED];
}

export function isSupported(provider: ProviderKind, action: ClientAction): boolean {
  return supportedActions(provider).includes(action);
}

/** Human label for the provider's web app (used by the escape-hatch link). */
export function providerLabel(provider: ProviderKind): string {
  return provider === "google" ? "Gmail" : "Outlook";
}

/**
 * Provider-native-only capabilities. Seer does not fake these; it links out.
 */
export const NATIVE_ONLY = [
  "rules and filters",
  "labels and folders",
  "delegated mailbox settings",
  "encryption and sensitivity",
  "advanced calendar options",
  "account settings",
] as const;
