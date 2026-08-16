"use client";

import * as React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Atlas } from "@/components/v2/Atlas";
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

type PreviewReader = {
  conversation: Conversation;
  provider: ProviderKind;
};

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

function writeHash(
  section: MailSection,
  conversation: string | null,
  query: string,
  sort: MailboxSort,
): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  params.set("section", section);
  if (conversation) params.set("conversation", conversation);
  if (query) params.set("q", query);
  if (sort !== "date") params.set("sort", sort);
  window.history.replaceState(null, "", `#${params.toString()}`);
  window.dispatchEvent(new Event("hashchange"));
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
  const [inboxSort, setInboxSort] = useState<MailboxSort>(
    preview?.mailbox.inbox.sort ?? "date",
  );
  // Cards are a mode of triage, not a separate screen: the same rows, dealt one
  // at a time instead of listed.
  const [cards, setCards] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    preview?.initialConversationId ?? null,
  );
  const [providerConversationId, setProviderConversationId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ReaderComposeIntent | { mode: "send" } | null>(
    preview?.initialCompose ? { mode: "send" } : null,
  );
  const [query, setQuery] = useState("");
  const [searchRows, setSearchRows] = useState<SearchResult[] | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean; outboxId?: string } | null>(null);
  const [hashReady, setHashReady] = useState(false);
  const restoredSearchRef = useRef<string | null>(null);
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
    sort: hashSort,
  } = parseMailHash(hashSnapshot);
  const pendingHashConversation =
    hashConversation && !hashAppliedRef.current ? hashConversation : null;
  const { modalOpen } = modalBackgroundState({
    isMobile,
    conversationId: conversationId ?? pendingHashConversation,
    composing: Boolean(compose),
  });
  const mobileModalOpen = isMobile && modalOpen;

  const folder = isFolder(section) ? section : "inbox";
  const mailboxSort: MailboxSort = folder === "inbox" ? inboxSort : "date";
  const previewView =
    mailboxSort === "triage" ? preview?.triageInbox : preview?.mailbox[folder];
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

  useEffect(() => {
    if (hashSection) setSection(hashSection);
    if (hashSort) setInboxSort(hashSort);
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
    hashSort,
    hashSnapshot,
    restoreSearch,
  ]);

  useEffect(() => {
    if (hashReady) writeHash(section, conversationId, query, inboxSort);
  }, [conversationId, hashReady, inboxSort, query, section]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAccountChanged = () => {
      searchGuard.current.invalidateForAccountChange();
      setConversationId(null);
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
  const readerPreview = useMemo(
    () => (preview && conversationId ? preview.reader : undefined),
    [conversationId, preview],
  );

  const navigate = (next: MailSection) => {
    searchGuard.current.cancel();
    setSection(next);
    setConversationId(null);
    setProviderConversationId(null);
    setCompose(null);
    setSearchRows(null);
    setQuery("");
    restoredSearchRef.current = null;
    setNotice(null);
  };

  const openRow = (row: MailboxRow) => {
    setConversationId(row.conversationId);
    setProviderConversationId(row.providerConversationId);
    setCompose(null);
  };

  const openAtlasConversation = useCallback((row: ConversationRow) => {
    setConversationId(row.conversationId);
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
    setProviderConversationId(null);
  };

  const clearSearch = () => {
    searchGuard.current.cancel();
    const cleared = clearSearchState(section);
    setQuery(cleared.query);
    setSearchRows(cleared.rows);
    setConversationId(cleared.conversation);
    setProviderConversationId(null);
    restoredSearchRef.current = null;
  };

  const openSearchResult = (row: SearchResult) => {
    if (!row.conversationId) return;
    setConversationId(row.conversationId);
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
      conversationId={conversationId}
      onBack={() => {
        setConversationId(null);
        setProviderConversationId(null);
      }}
      onCompose={(intent) => setCompose(intent)}
      onNotice={(message, error = false) => setNotice({ message, error })}
      accountId={mailbox.view?.accountId}
      onCommandComplete={() => {
        void mailbox.reload();
        setConversationId(null);
        setProviderConversationId(null);
      }}
      onProviderConversationId={rememberProviderConversationId}
      preview={readerPreview}
    />
  ) : null;

  const folderContent = searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : activeMailbox && cards && mailboxSort === "triage" ? (
    <TriageCards
      rows={activeMailbox.rows}
      onCommands={async (items) => {
        await runCommands(items.map((item) => item.command));
      }}
      onOpen={openRow}
      onExit={() => setCards(false)}
    />
  ) : activeMailbox ? (
    <FolderList
      view={activeMailbox}
      refreshing={mailbox.refreshing}
      sort={mailboxSort}
      onSortChange={folder === "inbox" ? setInboxSort : undefined}
      onOpen={openRow}
      onPrefetch={mailbox.prefetchBody}
      onCommands={runCommands}
      onCards={folder === "inbox" && mailboxSort === "triage" ? () => setCards(true) : undefined}
    />
  ) : (
    <section className="mail-folder-layout mail-reader-loading" aria-label="Loading mailbox">
      <p>{mailbox.error ? `Couldn’t load mail: ${mailbox.error}` : "Reading your mail…"}</p>
    </section>
  );

  const content = isFolder(section) ? (
    <div className="mail-workspace">
      <div
        className="mail-folder-pane"
        aria-label={`${section} folder`}
        aria-hidden={mobileModalOpen ? true : undefined}
        inert={mobileModalOpen ? true : undefined}
      >
        {folderContent}
      </div>
      {readerContent && (
        <div
          className="mail-reader-pane"
          aria-hidden={mobileModalOpen && Boolean(compose) ? true : undefined}
          inert={mobileModalOpen && Boolean(compose) ? true : undefined}
        >
          {readerContent}
        </div>
      )}
    </div>
  ) : conversationId ? (
    readerContent
  ) : searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : section === "atlas" ? (
    inbox.view ? (
      <>
        <Atlas
          view={inbox.view}
          onArchiveMatter={archiveMatter}
          onReplyMatter={(matter) => startMatterCompose(matter, "reply")}
          onForwardMatter={(matter) => startMatterCompose(matter, "forward")}
          onOpenConversation={openAtlasConversation}
        />
        <WorthReading view={inbox.view} />
      </>
    ) : (
      <p className="mail-empty">{inbox.error ?? "Reading Atlas…"}</p>
    )
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
        aria-hidden={mobileModalOpen && Boolean(compose) ? true : undefined}
        inert={mobileModalOpen && Boolean(compose) ? true : undefined}
      >
        <header
          className="mail-toolbar"
          aria-hidden={mobileModalOpen ? true : undefined}
          inert={mobileModalOpen ? true : undefined}
        >
          {/* The rail carries the mark on desktop; on a phone the rail is gone,
              so the toolbar is the only place the app can say whose it is. */}
          <SeerMark size={24} className="mail-toolbar-mark" />
          <SearchBox
            initialQuery={query}
            onSearch={search}
            onClear={clearSearch}
            requestGuard={searchGuard.current}
          />
          <span className="mail-toolbar-status" aria-live="polite">
            {mailbox.refreshing ? "Syncing…" : ""}
          </span>
        </header>
        <div className="mail-content">{content}</div>
      </main>
      {compose && (
        <ComposePane
          intent={compose.mode === "send" ? undefined : compose}
          providerConversationId={providerConversationId ?? undefined}
          conversationId={conversationId ?? undefined}
          accountId={mailbox.view?.accountId}
          preview={readerPreview?.conversation}
          previewProvider={readerPreview?.provider}
          onClose={() => setCompose(null)}
          onSent={noticeResult}
        />
      )}
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
