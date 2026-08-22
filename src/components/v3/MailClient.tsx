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
import { Atlas, type MatterMove } from "@/components/v2/Atlas";
import { WorthReading } from "@/components/v2/WorthReading";
import type { ConversationRow, InboxView, MatterCard } from "@/lib/v2/view/types";
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
import { TriageCards } from "./TriageCards";
import { MobileMailboxList } from "./MobileMailboxList";
import { fetchSearch, SearchBox, type SearchResult } from "./SearchBox";
import { SearchRequestGuard } from "./search-request";
import type { ReaderComposeIntent } from "@/components/v2/Reader";
import { ACCOUNT_CHANGED_EVENT, useMailbox } from "./useMailbox";
import { useInboxView } from "@/components/v2/useInboxView";
import {
  clearSearchState,
  modalBackgroundState,
  parseMailHash,
} from "./mail-client-state";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { reorderMatterSections } from "@/lib/v2/view/matter-order";

type PreviewReader = {
  conversation: Conversation;
  provider: ProviderKind;
};

type ComposeState =
  | { mode: "send" }
  | (ReaderComposeIntent & { expanded?: boolean });

export type MailClientPreview = {
  mailbox: Record<MailboxFolder, MailboxView>;
  /** The same inbox in triage order, so the sort control works without a server. */
  triageInbox?: MailboxView;
  inboxView: InboxView;
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
  // The section says whether this is the inbox or triage, so there is no
  // separate sort to remember.
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
    default:
      return "Updated";
  }
}

/**
 * Undo is offered for a single command only: the outbox undoes one queued
 * mutation by id, so promising it over a batch would silently restore one row
 * of fifty.
 */
function noticeForCommands(
  commands: Command[],
  results: CommandResult[],
): { message: string; error: boolean; outboxId?: string } {
  const label = pastTense(commands[0]);
  if (commands.length === 1) {
    const outboxId = results[0]?.outboxId;
    return outboxId
      ? {
          message: `${label} instantly. Undo before the provider catches up.`,
          error: false,
          outboxId,
        }
      : { message: `${label}.`, error: false };
  }
  const failed = commands.length - results.length;
  if (failed > 0) {
    return {
      message: `${label} ${results.length} of ${commands.length}. ${failed} failed.`,
      error: true,
    };
  }
  return { message: `${label} ${results.length} conversations.`, error: false };
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
  const [notice, setNotice] = useState<{ message: string; error: boolean; outboxId?: string } | null>(null);
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

  // Triage is a second reading of the inbox, not a fourth folder: same mail,
  // ordered by what to do with it rather than by when it landed.
  const triaging = section === "triage" || section === "cards";
  const dealing = section === "cards";
  const folder: MailboxFolder = isFolder(section) ? section : "inbox";
  const mailboxSort: MailboxSort = triaging ? "triage" : "date";
  const previewView = triaging ? preview?.triageInbox : preview?.mailbox[folder];
  const mailbox = useMailbox(folder, {
    initialView: previewView,
    disabled: Boolean(preview),
    sort: mailboxSort,
  });
  // Only Atlas reads this projection, and it is the heaviest response the app
  // has — every inbox conversation, every matter, every yield. Fetching it
  // while the user is in a mail folder cost a few hundred kB on load and again
  // on every window focus, which on a phone is constant.
  const inbox = useInboxView(
    preview?.inboxView,
    Boolean(preview) || section !== "atlas",
  );

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
   * two chased each other between "inbox" and "triage" until React gave up with
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
    const triageRows = preview.triageInbox?.rows ?? [];
    const atlasRows = preview.inboxView.atlas.flatMap(
      (matter) => matter.conversations,
    );
    return [...mailboxRows, ...triageRows, ...atlasRows].find(
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

  const openAtlasConversation = useCallback((row: ConversationRow) => {
    setConversationId(row.conversationId);
    setFocusedMessageId(null);
    setProviderConversationId(row.providerConversationId);
    setCompose(null);
  }, []);

  /**
   * A matter is a bundle of conversations, so acting on one from the board acts
   * on the thread that moved most recently: that is the one a reply belongs to
   * and the one a nudge answers.
   */
  const latestConversation = useCallback((matter: MatterCard) => {
    let latest: ConversationRow | null = null;
    let latestAt = -1;
    for (const conversation of matter.conversations) {
      const at = conversation.at ? Date.parse(conversation.at) : NaN;
      const rank = Number.isNaN(at) ? 0 : at;
      if (rank >= latestAt) {
        latestAt = rank;
        latest = conversation;
      }
    }
    return latest;
  }, []);

  const startMatterCompose = useCallback(
    (matter: MatterCard, mode: ReaderComposeIntent["mode"]) => {
      const conversation = latestConversation(matter);
      if (!conversation) return;
      setConversationId(conversation.conversationId);
      setFocusedMessageId(null);
      setProviderConversationId(conversation.providerConversationId);
      setCompose({ mode });
    },
    [latestConversation],
  );

  // Archiving a matter archives the mail it is made of. The board has already
  // struck the row through and is holding an undo, so nothing is awaited here.
  const archiveMatter = useCallback(
    async (matter: MatterCard) => {
      for (const conversation of matter.conversations) {
        await inbox.dispatch({
          type: "archive",
          conversationId: conversation.conversationId,
        });
      }
    },
    [inbox],
  );

  const archiveAtlasConversation = useCallback(
    (conversation: ConversationRow) => {
      void inbox.dispatch({
        type: "archive",
        conversationId: conversation.conversationId,
      });
    },
    [inbox],
  );

  const deleteAtlasConversation = useCallback(
    (conversation: ConversationRow) => {
      void inbox.dispatch({
        type: "delete",
        conversationId: conversation.conversationId,
        byUser: true,
      });
    },
    [inbox],
  );

  const reorderMatters = useCallback(
    async (section: string, matterIds: string[]) => {
      await inbox.dispatch(
        { type: "reorderMatters", section, matterIds },
        (view) => ({
          ...view,
          sections: view.sections.map((item) =>
            item.name === section
              ? {
                  ...item,
                  matters: matterIds
                    .map((id) =>
                      item.matters.find((matter) => matter.matterId === id),
                    )
                    .filter((matter): matter is MatterCard => Boolean(matter)),
                }
              : item,
          ),
        }),
      );
    },
    [inbox],
  );

  const moveMatter = useCallback(
    async (move: MatterMove) => {
      await inbox.dispatch(
        {
          type: "moveMatter",
          matterId: move.matterId,
          fromSection: move.fromSection,
          toSection: move.toSection,
          sourceMatterIds: move.sourceMatterIds,
          targetMatterIds: move.targetMatterIds,
        },
        (view) => ({
          ...view,
          sections: reorderMatterSections(view.sections, {
            matterId: move.matterId,
            targetSection: move.toSection,
            beforeMatterId:
              move.targetMatterIds[
                move.targetMatterIds.indexOf(move.matterId) + 1
              ] ?? null,
          }).sections,
        }),
      );
    },
    [inbox],
  );

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
        message: cause instanceof Error ? `Provider action failed: ${cause.message}` : "Provider action failed",
        error: true,
      });
      throw cause;
    }
  };

  const paletteActions: PaletteAction[] = [
    { id: "inbox", label: "Go to inbox", hint: "G I", run: () => navigate("inbox") },
    { id: "triage", label: "Go to triage", hint: "G T", run: () => navigate("triage") },
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
          t: "triage",
          s: "sent",
          d: "trash",
          a: "atlas",
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
        const json = (await response.json()) as { error?: string };
        throw new Error(json.error ?? `undo ${response.status}`);
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
  ) : activeMailbox && section === "triage" ? (
    <MobileMailboxList
      view={activeMailbox}
      triage
      currentConversationId={conversationId}
      onOpen={openRow}
      onCommands={runCommands}
      onCards={() => setSection("cards")}
    />
  ) : activeMailbox && dealing ? (
    <TriageCards
      rows={activeMailbox.rows}
      onCommands={async (items) => {
        await runCommands(items.map((item) => item.command));
      }}
      onOpen={openRow}
      onExit={() => setSection("triage")}
    />
  ) : activeMailbox && section === "inbox" ? (
    <MobileMailboxList
      view={activeMailbox}
      currentConversationId={conversationId}
      onOpen={openRow}
      onCommands={runCommands}
    />
  ) : activeMailbox ? (
    <FolderList
      view={activeMailbox}
      refreshing={mailbox.refreshing}
      onOpen={openRow}
      onPrefetch={mailbox.prefetchBody}
      onCommands={runCommands}
      onCards={triaging ? () => setSection("cards") : undefined}
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

  const atlasContent =
    inbox.view ? (
      <>
        <Atlas
          view={inbox.view}
          onArchiveMatter={archiveMatter}
          onReplyMatter={(matter) => startMatterCompose(matter, "reply")}
          onForwardMatter={(matter) => startMatterCompose(matter, "forward")}
          onOpenConversation={openAtlasConversation}
          onReorderMatters={reorderMatters}
          onMoveMatter={moveMatter}
          currentConversationId={conversationId}
          onArchiveConversation={archiveAtlasConversation}
          onDeleteConversation={deleteAtlasConversation}
        />
        {!conversationId ? <WorthReading view={inbox.view} /> : null}
      </>
    ) : (
      <p className="mail-empty">{inbox.error ?? "Reading Atlas…"}</p>
    );

  const masterDetail = isFolder(section) || triaging || section === "atlas";
  const content = masterDetail ? (
    <div
      className={`mail-workspace${
        section === "atlas" ? " mail-atlas-workspace" : ""
      }`}
    >
      <div
        className="mail-folder-pane"
        aria-label={section === "atlas" ? "Atlas matters" : `${section} mail`}
        inert={mobileModalOpen ? true : undefined}
      >
        {section === "atlas" ? atlasContent : folderContent}
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
            <strong>
              {section === "atlas"
                ? "Atlas"
                : section[0].toUpperCase() + section.slice(1)}
            </strong>
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
