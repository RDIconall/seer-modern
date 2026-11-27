"use client";

import * as React from "react";
import { Search as SearchIcon, X as CloseIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import type {
  MailboxFolder,
  MailboxRow,
  MailboxSort,
  MailboxView,
} from "@/lib/v3/mailbox/types";
import { ComposePane } from "./ComposePane";
import { FolderList } from "./FolderList";
import { Navigation, type MailSection } from "./Navigation";
import { ReaderPane } from "./ReaderPane";
import { SeerMark } from "./SeerMark";
import { Settings } from "./Settings";
import { InboxList } from "./InboxList";
import { fetchSearch, SearchBox, type SearchResult } from "./SearchBox";
import { SearchRequestGuard } from "./search-request";
import type { ReaderComposeIntent } from "@/components/v2/Reader";
import { ACCOUNT_CHANGED_EVENT, useMailbox } from "./useMailbox";
import {
  clearSearchState,
  modalBackgroundState,
  parseMailHash,
} from "./mail-client-state";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { fetchFresh } from "@/lib/v3/net/fetch";
import { describeHttpFailure, readJsonBody } from "@/lib/v3/net/json";

type PreviewReader = {
  conversation: Conversation;
  provider: ProviderKind;
};

type ComposeState =
  | { mode: "send" }
  | (ReaderComposeIntent & { expanded?: boolean });

export type MailClientPreview = {
  mailbox: Record<MailboxFolder, MailboxView>;
  reader: PreviewReader;
  initialSection?: MailSection;
  initialConversationId?: string;
  initialCompose?: boolean;
};

const folderSet = new Set<MailboxFolder>(["inbox", "sent", "trash"]);

function isFolder(section: MailSection): section is MailboxFolder {
  return folderSet.has(section as MailboxFolder);
}

function subscribeHash(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
}

function getHashSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function getServerHashSnapshot(): string {
  return "";
}

function buildHash(
  section: MailSection,
  conversation: string | null,
  query: string,
): string {
  const params = new URLSearchParams();
  params.set("section", section);
  if (conversation) params.set("conversation", conversation);
  if (query) params.set("q", query);
  return `#${params.toString()}`;
}

function writeHash(
  section: MailSection,
  conversation: string | null,
  query: string,
): string {
  const next = buildHash(section, conversation, query);
  if (typeof window === "undefined") return next;
  if (window.location.hash === next) return next;
  window.history.replaceState(null, "", next);
  window.dispatchEvent(new Event("hashchange"));
  return next;
}

const MOBILE_QUERY = "(max-width: 700px)";

function subscribeMobile(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const media = window.matchMedia(MOBILE_QUERY);
  const listener = () => onStoreChange();
  if (media.addEventListener) media.addEventListener("change", listener);
  else media.addListener(listener);
  return () => {
    if (media.removeEventListener) media.removeEventListener("change", listener);
    else media.removeListener(listener);
  };
}

function getMobileSnapshot(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

function getServerMobileSnapshot(): boolean {
  return false;
}

function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    getMobileSnapshot,
    getServerMobileSnapshot,
  );
}

function SearchResults({
  rows,
  onOpen,
}: {
  rows: SearchResult[];
  onOpen: (row: SearchResult) => void;
}) {
  return (
    <section className="mail-search-results" aria-label="Search results">
      <header className="mail-list-header">
        <div>
          <h1>Search results</h1>
          <p>{rows.length} result{rows.length === 1 ? "" : "s"}</p>
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="mail-empty">No matching conversations.</p>
      ) : (
        <ul className="mail-search-results-list">
          {rows.map((row) => (
            <li key={row.providerConversationId} className="mail-search-result">
              <button
                type="button"
                className="mail-list-open mail-focus-ring"
                disabled={!row.conversationId}
                onClick={() => onOpen(row)}
                aria-label={`Open search result ${row.subject || "conversation"}`}
              >
                <span className="mail-list-main">
                  <span className="mail-list-subject">{row.subject || "(no subject)"}</span>
                  <span className="mail-list-snippet">{row.snippet}</span>
                  {row.matterTitle && <span className="mail-search-matter">{row.matterTitle}</span>}
                </span>
                <span className="mail-list-meta">
                  {row.transient ? "Provider only" : "Stored"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function pastTense(command: Command): string {
  switch (command.type) {
    case "archive":
      return "Archived";
    case "restore":
      return "Restored";
    case "delete":
      return "Deleted";
    case "markUnread":
      return "Marked unread";
    case "setMatterNextStep":
      return "Next step saved";
    case "correctConversation":
      return command.home === "matter" ? "Added to a matter" : "Updated";
    case "triageConversation":
      return command.destination === "matter"
        ? "Added to a matter"
        : command.destination === "archive"
          ? "Archived"
          : "Deleted";
    default:
      return "Updated";
  }
}

function actionName(command: Command): string {
  switch (command.type) {
    case "archive":
      return "Archive";
    case "restore":
      return "Restore";
    case "delete":
      return "Delete";
    case "markUnread":
      return "Mark unread";
    case "setMatterNextStep":
      return "Save next step";
    case "correctConversation":
      return command.home === "matter" ? "Add to matter" : "Update";
    case "triageConversation":
      return command.destination === "matter"
        ? "Add to matter"
        : command.destination === "archive"
          ? "Archive"
          : "Delete";
    default:
      return "Action";
  }
}

type ActionNotice = {
  message: string;
  error: boolean;
  /** A single pending action can still be undone. */
  outboxId?: string;
  /** Every queued action is tracked through provider confirmation. */
  outboxIds?: string[];
  actionLabel?: string;
};

/**
 * Undo is offered for a single command only: the outbox undoes one queued
 * mutation by id, so promising it over a batch would silently restore one row
 * of fifty.
 */
export function noticeForCommands(
  commands: Command[],
  results: CommandResult[],
): ActionNotice {
  const label = pastTense(commands[0]);
  const action = actionName(commands[0]);
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const outboxIds = successful
    .map((result) => result.outboxId)
    .filter((id): id is string => Boolean(id));

  if (commands.length === 1 && failed[0]) {
    return {
      message: `${action} was not queued. The message is back in the list. ${
        failed[0].error ?? "Please try again."
      }`,
      error: true,
    };
  }

  if (outboxIds.length > 0) {
    const failedText =
      failed.length > 0
        ? ` ${failed.length} not queued and restored.`
        : "";
    return {
      message:
        commands.length === 1
          ? `${label} in Seer. Waiting for provider confirmation…`
          : `${outboxIds.length} queued.${failedText} Waiting for provider confirmation…`,
      error: failed.length > 0,
      outboxId:
        commands.length === 1 && outboxIds.length === 1
          ? outboxIds[0]
          : undefined,
      outboxIds,
      actionLabel: label,
    };
  }

  if (failed.length > 0) {
    return {
      message: `${successful.length} completed. ${failed.length} failed and restored.`,
      error: true,
    };
  }
  return {
    message:
      commands.length === 1
        ? `${label}.`
        : `${successful.length} conversations updated.`,
    error: false,
  };
}

export function MailClient({
  preview,
  mobile = false,
}: { preview?: MailClientPreview; mobile?: boolean } = {}) {
  const [section, setSection] = useState<MailSection>(preview?.initialSection ?? "inbox");
  const [conversationId, setConversationId] = useState<string | null>(
    preview?.initialConversationId ?? null,
  );
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [providerConversationId, setProviderConversationId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(
    preview?.initialCompose ? { mode: "send" } : null,
  );
  const [query, setQuery] = useState("");
  const [searchRows, setSearchRows] = useState<SearchResult[] | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [hashReady, setHashReady] = useState(false);
  const restoredSearchRef = useRef<string | null>(null);
  /** The last hash this client wrote, so it does not read its own writing. */
  const selfWrittenHash = useRef<string | null>(null);
  const searchGuard = useRef(new SearchRequestGuard());
  const hashAppliedRef = useRef(false);
  const isMobile = useIsMobile();

  const hashSnapshot = useSyncExternalStore(
    subscribeHash,
    getHashSnapshot,
    getServerHashSnapshot,
  );
  const {
    section: hashSection,
    conversation: hashConversation,
    query: hashQuery,
  } = parseMailHash(hashSnapshot);
  const pendingHashConversation =
    hashConversation && !hashAppliedRef.current ? hashConversation : null;
  const isFullCompose =
    compose?.mode === "send" ||
    (compose?.mode !== undefined && compose.expanded === true);
  const inlineIntent: ReaderComposeIntent | null =
    compose && compose.mode !== "send" && !compose.expanded
      ? { mode: compose.mode }
      : null;
  const { modalOpen } = modalBackgroundState({
    isMobile,
    conversationId: conversationId ?? pendingHashConversation,
    composing: isFullCompose,
  });
  const mobileModalOpen = isMobile && modalOpen;

  const folder: MailboxFolder = isFolder(section) ? section : "inbox";
  // The Inbox is read in matter order: the mail on one matter sits together and
  // the work that has waited longest leads. Sent and Trash are plain date lists.
  const mailboxSort: MailboxSort = section === "inbox" ? "matter" : "date";
  const previewView = preview?.mailbox[folder];
  const mailbox = useMailbox(folder, {
    initialView: previewView,
    disabled: Boolean(preview),
    sort: mailboxSort,
  });
  const reloadMailbox = mailbox.reload;
  /**
   * Optimistic actions are not provider confirmation. Track every queued row
   * until the provider says done, failed, or keeps retrying, so a disappearing
   * row never asks the user to guess whether Outlook/Gmail actually changed.
   */
  const trackedOutboxIds = notice?.outboxIds;
  const trackedActionLabel = notice?.actionLabel;
  useEffect(() => {
    if (!trackedOutboxIds?.length) return;
    let active = true;
    let checks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      checks += 1;
      try {
        const states = await Promise.all(
          trackedOutboxIds.map(async (id) => {
            const response = await fetchFresh(
              `/api/v3/outbox/${encodeURIComponent(id)}/status`,
            );
            if (!response.ok) throw new Error(`status ${response.status}`);
            return (await response.json()) as {
              status: "pending" | "inflight" | "done" | "failed" | "cancelled";
              attempts: number;
              lastError: string | null;
              reconcileNeeded: boolean;
            };
          }),
        );
        if (!active) return;
        const done = states.filter((state) => state.status === "done").length;
        const failed = states.filter((state) => state.status === "failed");
        const cancelled = states.filter(
          (state) => state.status === "cancelled",
        ).length;
        const waiting = states.length - done - failed.length - cancelled;

        if (failed.length > 0) {
          const providerReason = failed.find((state) => state.lastError)
            ?.lastError;
          setNotice({
            message: `${done} confirmed. ${failed.length} failed at the provider and the mailbox was refreshed.${
              providerReason ? ` ${providerReason}` : ""
            }`,
            error: true,
          });
          void reloadMailbox();
          return;
        }
        if (waiting === 0) {
          setNotice({
            message:
              cancelled > 0
                ? `${cancelled} action${cancelled === 1 ? "" : "s"} undone.`
                : `${trackedActionLabel ?? "Action"} confirmed by the provider.`,
            error: false,
          });
          return;
        }

        const retrying = states.filter(
          (state) =>
            (state.status === "pending" || state.status === "inflight") &&
            state.attempts > 0,
        );
        if (retrying.length > 0) {
          const reason = retrying.find((state) => state.lastError)?.lastError;
          setNotice((current) =>
            current
              ? {
                  ...current,
                  message: `${done} confirmed. ${waiting} still queued and retrying${
                    reason ? `: ${reason}` : "."
                  }`,
                  error: false,
                }
              : current,
          );
        }
        if (checks >= 20) {
          setNotice((current) =>
            current
              ? {
                  ...current,
                  message: `${done} confirmed. ${waiting} still queued; Seer will keep retrying in the background.`,
                  error: false,
                }
              : current,
          );
          return;
        }
      } catch {
        // A status request failing must not turn a successfully queued action
        // into a false provider failure. Try again while the toast remains.
      }
      if (active) timer = setTimeout(() => void check(), 1_500);
    };

    timer = setTimeout(() => void check(), 900);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [reloadMailbox, trackedActionLabel, trackedOutboxIds]);

  const restoreSearch = useCallback(async (value: string) => {
    if (restoredSearchRef.current === value) return;
    restoredSearchRef.current = value;
    const token = searchGuard.current.start();
    setQuery(value);
    try {
      const rows = await fetchSearch(value, token.signal);
      if (searchGuard.current.isCurrent(token)) setSearchRows(rows);
    } catch {
      if (searchGuard.current.isCurrent(token)) setSearchRows([]);
    }
  }, []);

  /**
   * The URL and this component both hold the same state, and each effect below
   * acts a render behind the other: the reader applies the hash, the writer
   * then writes the state it still had, and the reader applies that back. The
   * two chased each other between two sections until React gave up with
   * "Maximum update depth exceeded" and the error boundary blanked the client.
   *
   * A hash this client wrote is therefore not news. Only a hash from outside —
   * a first load, a pasted link, the back button — is applied.
   */
  useEffect(() => {
    if (hashSnapshot && hashSnapshot === selfWrittenHash.current) return;
    if (hashSection) setSection(hashSection);
    if (hashConversation) {
      hashAppliedRef.current = true;
      setConversationId(hashConversation);
    } else {
      hashAppliedRef.current = false;
    }
    if (hashQuery) void restoreSearch(hashQuery);
    setHashReady(true);
  }, [
    hashConversation,
    hashQuery,
    hashSection,
    hashSnapshot,
    restoreSearch,
  ]);

  useEffect(() => {
    if (!hashReady) return;
    selfWrittenHash.current = writeHash(section, conversationId, query);
  }, [conversationId, hashReady, query, section]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAccountChanged = () => {
      searchGuard.current.invalidateForAccountChange();
      setConversationId(null);
      setFocusedMessageId(null);
      setProviderConversationId(null);
      setSearchRows(null);
      setQuery("");
      restoredSearchRef.current = null;
      setNotice(null);
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
  }, []);

  const activeMailbox = mailbox.view;
  const previewProviderConversationId = useMemo(() => {
    if (!preview || !conversationId) return null;
    const mailboxRows = Object.values(preview.mailbox).flatMap(
      (view) => view.rows,
    );
    return mailboxRows.find(
      (row) => row.conversationId === conversationId,
    )?.providerConversationId;
  }, [conversationId, preview]);
  const readerPreview = useMemo(
    () =>
      preview &&
      conversationId &&
      previewProviderConversationId ===
        preview.reader.conversation.providerConversationId
        ? preview.reader
        : undefined,
    [conversationId, preview, previewProviderConversationId],
  );

  const navigate = (next: MailSection) => {
    searchGuard.current.cancel();
    setSection(next);
    setConversationId(null);
    setFocusedMessageId(null);
    setProviderConversationId(null);
    setCompose(null);
    setSearchRows(null);
    setQuery("");
    restoredSearchRef.current = null;
    setNotice(null);
  };

  const openRow = (row: MailboxRow) => {
    setConversationId(row.conversationId);
    setFocusedMessageId(row.latestMessageId ?? null);
    setProviderConversationId(row.providerConversationId);
    setCompose(null);
  };

  const rememberProviderConversationId = useCallback(
    (id: string) => setProviderConversationId(id),
    [],
  );

  const runCommands = async (commands: Command[]): Promise<CommandResult[]> => {
    try {
      const results = await mailbox.dispatchMany(commands);
      setNotice(noticeForCommands(commands, results));
      return results;
    } catch (cause) {
      setNotice({
        message:
          cause instanceof Error
            ? `Action status could not be determined. The list has been refreshed: ${cause.message}`
            : "Action status could not be determined. The list has been refreshed.",
        error: true,
      });
      throw cause;
    }
  };

  const paletteActions: PaletteAction[] = [
    { id: "inbox", label: "Go to inbox", hint: "G I", run: () => navigate("inbox") },
    { id: "sent", label: "Go to sent", hint: "G S", run: () => navigate("sent") },
    { id: "trash", label: "Go to trash", hint: "G D", run: () => navigate("trash") },
    { id: "compose", label: "Compose", hint: "C", run: () => setCompose({ mode: "send" }) },
    {
      id: "search",
      label: "Search mail",
      hint: "/",
      run: () => document.getElementById("mail-search-input")?.focus(),
    },
  ];

  const goPrefix = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable ||
        isFullCompose
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (key === "/") {
        event.preventDefault();
        document.getElementById("mail-search-input")?.focus();
        return;
      }
      if (key === "escape") {
        setPaletteOpen(false);
        if (inlineIntent) setCompose(null);
        else if (conversationId) {
          setConversationId(null);
          setFocusedMessageId(null);
        }
        return;
      }
      if (goPrefix.current) {
        goPrefix.current = false;
        const destination: Partial<Record<string, MailSection>> = {
          i: "inbox",
          s: "sent",
          d: "trash",
        };
        const next = destination[key];
        if (next) {
          event.preventDefault();
          navigate(next);
        }
        return;
      }
      if (key === "g") {
        goPrefix.current = true;
        window.setTimeout(() => {
          goPrefix.current = false;
        }, 1000);
        return;
      }
      if (key === "c") {
        event.preventDefault();
        setCompose({ mode: "send" });
        return;
      }
      if (conversationId && (key === "r" || key === "a" || key === "f")) {
        event.preventDefault();
        setCompose({
          mode:
            key === "r" ? "reply" : key === "a" ? "replyAll" : "forward",
        });
        return;
      }
      if (inlineIntent) return;
      if (conversationId && key === "e") {
        event.preventDefault();
        void runCommands([{ type: "archive", conversationId }]).then(() => {
          setConversationId(null);
          setFocusedMessageId(null);
        });
        return;
      }
      if ((key === "j" || key === "k") && activeMailbox?.rows.length) {
        event.preventDefault();
        const current = activeMailbox.rows.findIndex(
          (row) => row.conversationId === conversationId,
        );
        const delta = key === "j" ? 1 : -1;
        const nextIndex =
          current < 0
            ? key === "j"
              ? 0
              : activeMailbox.rows.length - 1
            : Math.min(
                activeMailbox.rows.length - 1,
                Math.max(0, current + delta),
              );
        openRow(activeMailbox.rows[nextIndex]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const undo = async () => {
    if (!notice?.outboxId) return;
    try {
      const response = await fetch(`/api/v3/outbox/${encodeURIComponent(notice.outboxId)}/undo`, {
        method: "POST",
      });
      if (!response.ok) {
        const json = await readJsonBody<{ error?: string }>(response);
        throw new Error(json?.error ?? describeHttpFailure(response.status));
      }
      await mailbox.reload();
      setNotice({ message: "Undone before provider delivery.", error: false });
    } catch (cause) {
      setNotice({
        message: cause instanceof Error ? `Undo failed: ${cause.message}` : "Undo failed",
        error: true,
      });
    }
  };

  const search = (value: string, rows: SearchResult[]) => {
    restoredSearchRef.current = value;
    setQuery(value);
    setSearchRows(rows);
    setConversationId(null);
    setFocusedMessageId(null);
    setProviderConversationId(null);
  };

  const clearSearch = () => {
    searchGuard.current.cancel();
    const cleared = clearSearchState(section);
    setQuery(cleared.query);
    setSearchRows(cleared.rows);
    setConversationId(cleared.conversation);
    setFocusedMessageId(null);
    setProviderConversationId(null);
    restoredSearchRef.current = null;
  };

  const openSearchResult = (row: SearchResult) => {
    if (!row.conversationId) return;
    setConversationId(row.conversationId);
    setFocusedMessageId(null);
    setProviderConversationId(row.providerConversationId);
    setSearchRows(null);
  };

  const noticeResult = (result: CommandResult) => {
    setCompose(null);
    setNotice({
      message: result.pending
        ? "Sent. Waiting for provider confirmation."
        : "Sent.",
      error: false,
      outboxId: result.outboxId,
    });
  };

  const readerContent = conversationId ? (
    <ReaderPane
      key={`${conversationId}:${focusedMessageId ?? ""}`}
      conversationId={conversationId}
      focusMessageId={focusedMessageId ?? undefined}
      onBack={() => {
        setConversationId(null);
        setFocusedMessageId(null);
        setProviderConversationId(null);
      }}
      onCompose={(intent) => setCompose(intent)}
      inlineIntent={inlineIntent}
      onInlineClose={() => setCompose(null)}
      onExpand={(intent) => setCompose({ ...intent, expanded: true })}
      onSent={noticeResult}
      onNotice={(message, error = false) => setNotice({ message, error })}
      accountId={mailbox.view?.accountId}
      onCommandComplete={() => {
        void mailbox.reload();
        setConversationId(null);
        setFocusedMessageId(null);
        setProviderConversationId(null);
      }}
      onProviderConversationId={rememberProviderConversationId}
      preview={readerPreview}
    />
  ) : null;

  const folderContent = searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : activeMailbox && section === "inbox" ? (
    <InboxList
      view={activeMailbox}
      refreshing={mailbox.refreshing}
      currentConversationId={conversationId}
      onOpen={openRow}
      onPrefetch={mailbox.prefetchBody}
      onCommands={runCommands}
    />
  ) : activeMailbox ? (
    <FolderList
      view={activeMailbox}
      refreshing={mailbox.refreshing}
      onOpen={openRow}
      onPrefetch={mailbox.prefetchBody}
      onCommands={runCommands}
    />
  ) : (
    <section className="mail-folder-layout mail-reader-loading" aria-label="Loading mailbox">
      {mailbox.error === "no active account" ? (
        <div className="mail-empty-account">
          <p>No mailbox is connected to Seer yet.</p>
          <button
            type="button"
            className="mail-focus-ring"
            onClick={() => setSection("settings")}
          >
            Connect an account
          </button>
        </div>
      ) : (
        <p>{mailbox.error ? `Couldn’t load mail: ${mailbox.error}` : "Reading your mail…"}</p>
      )}
    </section>
  );

  const masterDetail = isFolder(section);
  const content = masterDetail ? (
    <div className="mail-workspace">
      <div
        className="mail-folder-pane"
        aria-label={`${section} mail`}
        inert={mobileModalOpen ? true : undefined}
      >
        {folderContent}
      </div>
      {readerContent && (
        <div
          className="mail-reader-pane"
          aria-hidden={mobileModalOpen && isFullCompose ? true : undefined}
          inert={mobileModalOpen && isFullCompose ? true : undefined}
        >
          {readerContent}
        </div>
      )}
    </div>
  ) : searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : (
    <Settings mobile={mobile} />
  );

  return (
    <div className="mail-client" data-reader-open={conversationId ? "true" : "false"}>
      <Navigation
        active={section}
        onNavigate={navigate}
        onCompose={() => setCompose({ mode: "send" })}
        modalOpen={modalOpen}
      />
      <main
        className="mail-main"
        aria-hidden={mobileModalOpen && isFullCompose ? true : undefined}
        inert={mobileModalOpen && isFullCompose ? true : undefined}
      >
        <header
          className="mail-toolbar"
          aria-hidden={mobileModalOpen ? true : undefined}
          inert={mobileModalOpen ? true : undefined}
        >
          {/* The rail carries the mark on desktop; on a phone the rail is gone,
              so the toolbar is the only place the app can say whose it is. */}
          <SeerMark size={24} className="mail-toolbar-mark" />
          <div className="mail-mobile-title">
            <strong>{section[0].toUpperCase() + section.slice(1)}</strong>
          </div>
          <div
            className="mail-toolbar-search"
            data-mobile-open={mobileSearchOpen ? "true" : "false"}
          >
            <SearchBox
              initialQuery={query}
              onSearch={search}
              onClear={clearSearch}
              requestGuard={searchGuard.current}
            />
          </div>
          <button
            type="button"
            className="mail-mobile-search-toggle"
            aria-label={mobileSearchOpen ? "Close search" : "Search mail"}
            onClick={() => setMobileSearchOpen((open) => !open)}
          >
            {mobileSearchOpen ? <CloseIcon aria-hidden /> : <SearchIcon aria-hidden />}
          </button>
          <span className="mail-toolbar-status" aria-live="polite">
            {mailbox.refreshing ? "Syncing…" : ""}
          </span>
        </header>
        <div className="mail-content">{content}</div>
      </main>
      {compose && isFullCompose && (
        <ComposePane
          intent={
            compose.mode === "send"
              ? undefined
              : { mode: compose.mode }
          }
          providerConversationId={providerConversationId ?? undefined}
          conversationId={conversationId ?? undefined}
          accountId={mailbox.view?.accountId}
          preview={readerPreview?.conversation}
          previewProvider={readerPreview?.provider}
          onClose={() => setCompose(null)}
          onSent={noticeResult}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
      />
      {notice && (
        <div className={notice.error ? "mail-toast mail-toast-error" : "mail-toast"} role={notice.error ? "alert" : "status"}>
          <span>{notice.message}</span>
          {notice.outboxId && !notice.error && (
            <button type="button" className="mail-toast-action mail-focus-ring" onClick={() => void undo()}>
              Undo
            </button>
          )}
          <button
            type="button"
            className="mail-toast-dismiss mail-focus-ring"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
