/**
 * Outlook folder scoping. Graph's `conversationId` filter on /me/messages
 * spans the whole mailbox, so a conversation read returns Junk Email, Drafts,
 * Outbox and Conversation History items next to the inbox copy. Those are never
 * shown or acted on as part of the thread. `parentFolderId` is an opaque folder
 * id: compare it only to ids resolved from Graph's well-known folder names.
 */

export const OUTLOOK_HIDDEN_FOLDERS = [
  "junkemail",
  "drafts",
  "outbox",
  "conversationhistory",
] as const;

export type OutlookHiddenFolder = (typeof OUTLOOK_HIDDEN_FOLDERS)[number];

export type OutlookWellKnownFolder =
  | "inbox"
  | "archive"
  | "deleteditems"
  | OutlookHiddenFolder;

export const OUTLOOK_WELL_KNOWN_FOLDERS: readonly OutlookWellKnownFolder[] = [
  "inbox",
  "archive",
  "deleteditems",
  ...OUTLOOK_HIDDEN_FOLDERS,
];

/**
 * Folders a mailbox may lack. Every other well-known folder always exists, so a
 * failed lookup for it is an error rather than "no such folder" — otherwise a
 * Junk Email lookup failure would turn the filter off.
 */
export const OUTLOOK_OPTIONAL_FOLDERS: ReadonlySet<OutlookWellKnownFolder> = new Set([
  "archive",
  "conversationhistory",
]);

/** Resolved folder ids; null when the mailbox has no such (optional) folder. */
export type OutlookFolderIds = Record<OutlookWellKnownFolder, string | null>;

/**
 * - `include`: Deleted Items copies are part of the thread (trash sync).
 * - `exclude`: they are not (inbox / sent sync).
 * - `whenOnlyDeleted`: they are only when nothing else in the thread is
 *   visible, so a fully trashed thread can still be read and restored.
 */
export type DeletedItemsScope = "include" | "exclude" | "whenOnlyDeleted";

/** Ids of messages that are positively in a hidden folder (not Deleted Items). */
export function hiddenOutlookMessageIds(
  messages: { id: string; parentFolderId?: string }[],
  folders: Pick<OutlookFolderIds, OutlookHiddenFolder>,
): string[] {
  const hidden = new Set<string>();
  for (const name of OUTLOOK_HIDDEN_FOLDERS) {
    const id = folders[name];
    if (id) hidden.add(id);
  }
  return messages
    .filter((m) => m.parentFolderId !== undefined && hidden.has(m.parentFolderId))
    .map((m) => m.id);
}

export function visibleOutlookMessages<T extends { parentFolderId?: string }>(
  messages: T[],
  folders: Pick<OutlookFolderIds, "deleteditems" | OutlookHiddenFolder>,
  deletedItems: DeletedItemsScope,
): T[] {
  const hidden = new Set<string>();
  for (const name of OUTLOOK_HIDDEN_FOLDERS) {
    const id = folders[name];
    if (id) hidden.add(id);
  }
  // A message without a folder id cannot be placed, so it is not shown.
  const shown = messages.filter(
    (m) => typeof m.parentFolderId === "string" && m.parentFolderId !== "" && !hidden.has(m.parentFolderId),
  );
  const deletedId = folders.deleteditems;
  if (deletedItems === "include" || !deletedId) return shown;
  const live = shown.filter((m) => m.parentFolderId !== deletedId);
  if (deletedItems === "exclude") return live;
  return live.length > 0 ? live : shown;
}
