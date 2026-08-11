"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Atlas } from "@/components/v2/Atlas";
import { Triage } from "@/components/v2/Triage";
import { WorthReading } from "@/components/v2/WorthReading";
import type { InboxView } from "@/lib/v2/view/types";
import type { CommandResult } from "@/lib/v2/commands/types";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import type { MailboxFolder, MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { ComposePane } from "./ComposePane";
import { FolderList } from "./FolderList";
import { Navigation, type MailSection } from "./Navigation";
import { ReaderPane } from "./ReaderPane";
import { fetchSearch, SearchBox, type SearchResult } from "./SearchBox";
import type { ReaderComposeIntent } from "@/components/v2/Reader";
import { useMailbox } from "./useMailbox";
import { useInboxView } from "@/components/v2/useInboxView";
import {
  clearSearchState,
  parseMailHash,
  type MailHash,
} from "./mail-client-state";

type PreviewReader = {
  conversation: Conversation;
  provider: ProviderKind;
};

export type MailClientPreview = {
  mailbox: Record<MailboxFolder, MailboxView>;
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

function readHash(): MailHash {
  if (typeof window === "undefined") return {};
  return parseMailHash(window.location.hash);
}

function writeHash(section: MailSection, conversation: string | null, query: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  params.set("section", section);
  if (conversation) params.set("conversation", conversation);
  if (query) params.set("q", query);
  window.history.replaceState(null, "", `#${params.toString()}`);
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

export function MailClient({ preview }: { preview?: MailClientPreview } = {}) {
  const [section, setSection] = useState<MailSection>(preview?.initialSection ?? "inbox");
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

  const folder = isFolder(section) ? section : "inbox";
  const mailbox = useMailbox(folder, {
    initialView: preview?.mailbox[folder],
    disabled: Boolean(preview),
  });
  const inbox = useInboxView(
    preview?.inboxView,
    Boolean(preview),
  );

  const restoreSearch = useCallback(async (value: string) => {
    if (restoredSearchRef.current === value) return;
    restoredSearchRef.current = value;
    setQuery(value);
    try {
      setSearchRows(await fetchSearch(value));
    } catch {
      setSearchRows([]);
    }
  }, []);

  useEffect(() => {
    const hash = readHash();
    if (hash.section) setSection(hash.section);
    if (hash.conversation) setConversationId(hash.conversation);
    if (hash.query) void restoreSearch(hash.query);
    setHashReady(true);
  }, [restoreSearch]);

  useEffect(() => {
    if (hashReady) writeHash(section, conversationId, query);
  }, [conversationId, hashReady, query, section]);

  const activeMailbox = mailbox.view;
  const readerPreview = useMemo(
    () => (preview && conversationId ? preview.reader : undefined),
    [conversationId, preview],
  );

  const navigate = (next: MailSection) => {
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

  const rememberProviderConversationId = useCallback(
    (id: string) => setProviderConversationId(id),
    [],
  );

  const action = async (row: MailboxRow, kind: "archive" | "restore") => {
    try {
      const result = await mailbox.dispatch({ type: kind, conversationId: row.conversationId });
      if (result.outboxId) {
        setNotice({
          message: `${kind === "archive" ? "Archived" : "Restored"} instantly. Undo before the provider catches up.`,
          error: false,
          outboxId: result.outboxId,
        });
      } else {
        setNotice({ message: `${kind === "archive" ? "Archived" : "Restored"}.`, error: false });
      }
    } catch (cause) {
      setNotice({
        message: cause instanceof Error ? `Provider action failed: ${cause.message}` : "Provider action failed",
        error: true,
      });
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
      onProviderConversationId={rememberProviderConversationId}
      preview={readerPreview}
    />
  ) : null;

  const folderContent = searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : activeMailbox ? (
    <FolderList
      view={activeMailbox}
      refreshing={mailbox.refreshing}
      onOpen={openRow}
      onPrefetch={mailbox.prefetchBody}
      onAction={(row, kind) => void action(row, kind)}
    />
  ) : (
    <section className="mail-folder-layout mail-reader-loading" aria-label="Loading mailbox">
      <p>{mailbox.error ? `Couldn’t load mail: ${mailbox.error}` : "Reading your mail…"}</p>
    </section>
  );

  const content = isFolder(section) ? (
    <div className="mail-workspace">
      <div className="mail-folder-pane" aria-label={`${section} folder`}>
        {folderContent}
      </div>
      {readerContent && <div className="mail-reader-pane">{readerContent}</div>}
    </div>
  ) : conversationId ? (
    readerContent
  ) : searchRows ? (
    <SearchResults rows={searchRows} onOpen={openSearchResult} />
  ) : section === "atlas" ? (
    inbox.view ? (
      <>
        <Atlas view={inbox.view} />
        <WorthReading view={inbox.view} />
      </>
    ) : (
      <p className="mail-empty">{inbox.error ?? "Reading Atlas…"}</p>
    )
  ) : section === "triage" ? (
    inbox.view ? (
      <Triage view={inbox.view} dispatch={inbox.dispatch} />
    ) : (
      <p className="mail-empty">{inbox.error ?? "Reading Triage…"}</p>
    )
  ) : (
    <section className="mail-settings" aria-label="Settings">
      <h1>Settings</h1>
      <p>Account and provider connections will live here.</p>
      <p className="mail-native-note">Provider-native settings remain available from the account menu.</p>
    </section>
  );

  return (
    <div className="mail-client" data-reader-open={conversationId ? "true" : "false"}>
      <Navigation active={section} onNavigate={navigate} onCompose={() => setCompose({ mode: "send" })} />
      <main className="mail-main">
        <header className="mail-toolbar">
          <SearchBox
            initialQuery={query}
            onSearch={search}
            onClear={clearSearch}
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
