"use client";

import { sanitizeEmailHtml } from "@/lib/inbox/sanitize";
import {
  Archive,
  Check,
  Forward,
  Inbox,
  Layers,
  ListFilter,
  LogOut,
  PenSquare,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { logout } from "@/app/actions";
import { CardStack } from "@/components/inbox/CardStack";
import { ComposePanel } from "@/components/inbox/ComposePanel";
import { DelegateSheet } from "@/components/inbox/DelegateSheet";
import { ScheduleSheet } from "@/components/inbox/ScheduleSheet";
import { UnsubAgentSheet } from "@/components/inbox/UnsubAgentSheet";
import { VipSheet } from "@/components/inbox/VipSheet";
import { BriefView } from "@/components/inbox/BriefView";
import { AssistBar } from "@/components/inbox/AssistBar";
import {
  LogicExplain,
  LogicToggle,
  ReaderGuideBar,
} from "@/components/inbox/LogicExplain";
import { SettingsPanel } from "@/components/inbox/SettingsPanel";
import { type TriageAction } from "@/lib/inbox/classify";
import { useMailbox } from "@/lib/inbox/use-mailbox";
import {
  buildDeckCards,
  ensureRe,
  formatMailTime,
  mailInitial,
  type EmailItem,
  type ViewTab,
} from "@/lib/inbox/types";

const FOLDER_LABEL: Record<ViewTab, string> = {
  inbox: "Inbox",
  sent: "Sent",
  trash: "Trash",
  triage: "Triage",
  cards: "Cards",
};

const FOLDERS: { tab: ViewTab; label: string; icon: ReactNode }[] = [
  { tab: "inbox", label: "Inbox", icon: <Inbox className="h-4 w-4" /> },
  { tab: "sent", label: "Sent", icon: <Send className="h-4 w-4" /> },
  { tab: "trash", label: "Trash", icon: <Trash2 className="h-4 w-4" /> },
  { tab: "cards", label: "Cards", icon: <Layers className="h-4 w-4" /> },
  { tab: "triage", label: "Triage", icon: <ListFilter className="h-4 w-4" /> },
];

export function DesktopMailApp() {
  const mb = useMailbox();
  const {
    tab,
    selectFolder,
    triage,
    mailbox,
    listItems,
    error,
    loading,
    search,
    setSearch,
    query,
    submitSearch,
    readerId,
    reader,
    compose,
    setCompose,
    toast,
    setToast,
    busyId,
    accountEmail,
    accountLabel,
    load,
    refreshIdentity,
    runAction,
    snooze,
    delegateFor,
    delegating,
    openDelegate,
    closeDelegate,
    confirmDelegate,
    scheduleFor,
    scheduling,
    openSchedule,
    closeSchedule,
    confirmSchedule,
    bulkSection,
    runBulk,
    unsubscribe,
    teachSender,
    openReader,
    closeReader,
    startCompose,
    startReply,
    draftReply,
    drafting,
    nudge,
    nudging,
    rsvp,
    rsvping,
  } = mb;

  const searchParams = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logicMode, setLogicMode] = useState(false);

  // Density: compact rows (persisted, shared key with mobile)
  const [dense, setDense] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("seer:dense") === "1";
  });
  const toggleDense = () => {
    setDense((d) => {
      try {
        window.localStorage.setItem("seer:dense", d ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !d;
    });
  };

  const [unsubAgentOpen, setUnsubAgentOpen] = useState(false);
  const [vipsOpen, setVipsOpen] = useState(false);

  // Multi-select in mail lists
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  useEffect(() => {
    setPicked(new Set());
  }, [tab]);
  const pickedItems = useMemo(
    () =>
      listItems
        .filter((i) => picked.has(i.id))
        .map((i) => ({ id: i.id, fromEmail: i.fromEmail })),
    [listItems, picked],
  );
  const deckCards = useMemo(() => buildDeckCards(triage), [triage]);

  useEffect(() => {
    if (searchParams.get("settings") === "1") setSettingsOpen(true);
  }, [searchParams]);


  const replyFromCard = async (id: string) => {
    try {
      const res = await fetch(`/api/messages/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setCompose({
        mode: "reply",
        to: json.message.fromEmail,
        cc: "",
        subject: ensureRe(json.message.subject),
        body: "",
        replyToId: id,
      });
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not reply");
    }
  };

  if (compose) {
    const wasHandoff = compose.archiveOriginal;
    return (
      <ComposePanel
        draft={compose}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null);
          closeReader();
          setToast(
            wasHandoff ? "Handed off — original archived" : "Message sent",
          );
          if (tab === "sent" || wasHandoff) load();
        }}
      />
    );
  }

  const safeHtml = reader?.htmlBody ? sanitizeEmailHtml(reader.htmlBody) : "";
  const listTitle = query ? "Search results" : FOLDER_LABEL[tab];

  return (
    <div className="flex h-[100dvh] min-h-screen overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      {delegateFor ? (
        <DelegateSheet
          subject={delegateFor.subject}
          busy={delegating}
          onConfirm={confirmDelegate}
          onClose={closeDelegate}
        />
      ) : null}
      {scheduleFor ? (
        <ScheduleSheet
          subject={scheduleFor.subject}
          ask={scheduleFor.ask}
          busy={scheduling}
          onConfirm={confirmSchedule}
          onClose={closeSchedule}
        />
      ) : null}
      {vipsOpen ? (
        <VipSheet
          onClose={() => setVipsOpen(false)}
          onChanged={() => load()}
        />
      ) : null}
      {unsubAgentOpen ? (
        <UnsubAgentSheet
          onClose={() => setUnsubAgentOpen(false)}
          onDone={(summary) => {
            setToast(summary);
            load();
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onAccountsChanged={() => {
            refreshIdentity();
            load();
          }}
        />
      ) : null}

      {/* Left sidebar */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)]">
        <div className="border-b border-[var(--border)] px-4 py-4">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/seer-mark.png" alt="" width={26} height={26} />
            <span className="seer-brand text-lg">Seer</span>
          </div>
          <div className="seer-tagline mt-0.5 text-[11px]">Work smarter</div>
        </div>

        <div className="px-3 py-3">
          <button
            type="button"
            onClick={startCompose}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-[var(--brand-strong)]"
          >
            <PenSquare className="h-4 w-4" />
            Compose
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {FOLDERS.map(({ tab: folderTab, label, icon }) => (
            <button
              key={folderTab}
              type="button"
              onClick={() => selectFolder(folderTab)}
              className={`mb-0.5 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                tab === folderTab
                  ? "bg-[var(--brand-soft)] font-medium text-[var(--fg-strong)]"
                  : "text-[var(--fg)] hover:bg-[var(--row-hover)]"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-[var(--fg)] hover:bg-[var(--row-hover)]"
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>
        </nav>

        <div className="border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-full text-left"
          >
            <div
              className="truncate text-xs font-medium"
              title={accountEmail}
            >
              {accountEmail}
            </div>
            {accountLabel ? (
              <div className="truncate text-[11px] text-[var(--primary)]">
                {accountLabel}
              </div>
            ) : null}
            <div className="mt-0.5 text-[11px] text-[var(--muted)]">
              Manage accounts
            </div>
          </button>
          <form action={logout} className="mt-2">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg)]"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {tab === "cards" ? (
        <section className="flex min-w-0 flex-1 overflow-hidden">
          {/* Full-bleed teal deck — the preview docks beside it instead of floating over it */}
          <div className="seer-deck-bg flex min-w-0 flex-1 flex-col overflow-hidden">
            {error ? (
              <p className="mx-6 mt-4 rounded-md bg-white/90 px-3 py-2 text-sm font-medium text-[#d63b2f]">
                {error}
              </p>
            ) : null}
            {loading && !triage ? (
              <p className="py-20 text-center text-sm text-white/90">
                Loading cards…
              </p>
            ) : (
              <div className="mx-auto flex w-full max-w-xl flex-1 flex-col overflow-y-auto py-6">
                <CardStack
                  deck={deckCards}
                  busyId={busyId}
                  onOpen={openReader}
                  onAction={runAction}
                  onBulk={bulkSection}
                  onReply={replyFromCard}
                  onSnooze={snooze}
                  onDelegate={openDelegate}
                  onSchedule={openSchedule}
                  onEmptyRefresh={load}
                />
              </div>
            )}
          </div>
          {readerId && reader ? (
            <aside className="flex w-[30rem] max-w-[46%] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-[var(--fg-strong)]">
                  {reader.subject}
                </h2>
                <button
                  type="button"
                  onClick={closeReader}
                  aria-label="Close preview"
                  className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {reader.guide ? (
                <div className="px-4 pb-1">
                  <ReaderGuideBar
                    guide={reader.guide}
                    onTeach={(a) =>
                      teachSender(reader.fromEmail, a, readerId ?? undefined)
                    }
                  />
                </div>
              ) : null}
              <div className="flex-1 overflow-auto px-5 py-4">
                {reader.htmlBody ? (
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeEmailHtml(reader.htmlBody),
                    }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm">
                    {reader.textBody}
                  </pre>
                )}
              </div>
            </aside>
          ) : null}
          {toast ? (
            <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded bg-[#1e242b] px-4 py-2 text-xs text-white">
              {toast}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Middle + reading panes (hidden in Cards mode) */}
      {tab !== "cards" ? (
      <>
      <section className="flex w-[360px] shrink-0 flex-col border-r border-[var(--border)]">
        <header className="shrink-0 border-b border-[var(--border)]">
          <div className="flex items-center justify-between gap-2 bg-[var(--brand)] px-4 py-3 text-white">
            <h1 className="text-lg font-semibold">{listTitle}</h1>
            <div className="flex items-center gap-2">
              {(tab === "inbox" || tab === "triage" || Boolean(query)) && (
                <LogicToggle
                  on={logicMode}
                  onToggle={() => setLogicMode((v) => !v)}
                />
              )}
              {tab !== "triage" && mailbox ? (
                <span className="text-xs text-white/80">{mailbox.count}</span>
              ) : tab === "triage" && triage ? (
                <span className="text-xs text-white/80">{triage.count}</span>
              ) : null}
            </div>
          </div>
          <form
            className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mail"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
            />
          </form>
          {tab === "triage" && (triage?.assistant || triage?.history) ? (
            <p className="flex items-start gap-2 bg-[var(--card)] px-4 py-2 text-[11px] text-[var(--muted)]">
              <span className="order-last ml-auto flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => setVipsOpen(true)}
                  className="rounded-full border border-[#eab308] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]"
                >
                  VIPs
                </button>
                <button
                  type="button"
                  onClick={() => setUnsubAgentOpen(true)}
                  className="rounded-full border border-[#a855f7] px-2 py-0.5 text-[10px] font-semibold text-[#a855f7]"
                >
                  Unsub agent
                </button>
                <button
                  type="button"
                  onClick={toggleDense}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)]"
                >
                  {dense ? "Cozy" : "Compact"}
                </button>
              </span>
              {logicMode && triage.assistant
                ? `Gemini ${triage.assistant.gemini} · rules ${triage.assistant.rules}${triage.assistant.learned ? ` · learned ${triage.assistant.learned}` : ""} · taught ${triage.assistant.override}${triage.assistant.cached ? ` · cached ${triage.assistant.cached}` : ""} · your call ${triage.assistant.needsReview}`
                : `${triage.count} triaged · ${triage.assistant?.needsReview ?? triage.needsReview.length} need you`}
              {triage.assistant?.error ? (
                <span className="ml-2 font-medium text-[#b45309]">
                  {(triage.assistant.gemini ?? 0) + (triage.assistant.cached ?? 0) > 0
                    ? "Some new mail used rules this load — "
                    : "Gemini offline — rules only: "}
                  {triage.assistant.error.slice(0, 110)}
                </span>
              ) : null}
            </p>
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="mx-3 my-3 rounded-md bg-[#d63b2f]/10 px-3 py-2 text-sm text-[#d63b2f]">
              {error}
            </p>
          ) : null}

          {loading &&
          ((tab === "triage" && !triage) || (tab !== "triage" && !mailbox)) ? (
            <p className="py-12 text-center text-sm text-[var(--muted)]">Loading…</p>
          ) : null}

          {tab !== "triage" && mailbox ? (
            listItems.length === 0 ? (
              <EmptyList
                text={
                  query
                    ? "No matches"
                    : tab === "inbox"
                      ? "Your inbox is empty"
                      : `${FOLDER_LABEL[tab]} is empty`
                }
              />
            ) : (
              <>
                {picked.size > 0 ? (
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--brand-soft)] px-3 py-1.5">
                    <span className="text-[12px] font-semibold">
                      {picked.size} selected
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        runBulk(pickedItems, "archive");
                        setPicked(new Set());
                      }}
                      className="rounded px-2 py-1 text-[12px] font-semibold text-[#76ab19] hover:bg-[var(--card)]"
                    >
                      Archive
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        runBulk(pickedItems, "trash");
                        setPicked(new Set());
                      }}
                      className="rounded px-2 py-1 text-[12px] font-semibold text-[#d63b2f] hover:bg-[var(--card)]"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        runBulk(pickedItems, "read");
                        setPicked(new Set());
                      }}
                      className="rounded px-2 py-1 text-[12px] font-semibold text-[var(--primary)] hover:bg-[var(--card)]"
                    >
                      Mark read
                    </button>
                    <button
                      type="button"
                      onClick={() => setPicked(new Set())}
                      className="ml-auto rounded px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--card)]"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
                <ul>
                  {listItems.map((item) => (
                    <DesktopMailRow
                      key={item.id}
                      item={item}
                      selected={readerId === item.id}
                      busy={busyId === item.id}
                      showGuide={tab === "inbox" || Boolean(query)}
                      logicMode={logicMode}
                    onTeach={(a) => teachSender(item.fromEmail, a, item.id)}
                      checked={picked.has(item.id)}
                      onToggleSelect={() => togglePick(item.id)}
                      onOpen={() => openReader(item.id)}
                      onArchive={
                        tab === "inbox"
                          ? () => runAction(item.id, "archive", item.fromEmail)
                          : undefined
                      }
                      onDelete={() => runAction(item.id, "trash", item.fromEmail)}
                    />
                  ))}
                </ul>
              </>
            )
          ) : null}

          {tab === "triage" && triage && triage.count === 0 ? (
            <EmptyList text="Nothing to triage" />
          ) : null}

          {tab === "triage" && triage && triage.count > 0 ? (
            <BriefView
              triage={triage}
              h={{
                openReader,
                runAction,
                bulkSection,
                unsubscribe,
                teachSender,
                nudge,
                nudging,
                logicMode,
                busyId,
              }}
            />
          ) : null}
        </div>
      </section>

      {/* Right pane — reading */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!readerId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
            Select a message
          </div>
        ) : (
          <>
            <header className="shrink-0 border-b border-[var(--border)] px-6 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="min-w-0 flex-1 basis-60 text-xl font-semibold leading-snug text-[var(--fg-strong)]">
                  {reader?.subject ?? "…"}
                </h2>
                <ReaderToolbar
                  disabled={!reader || busyId === readerId}
                  onReply={() => startReply("reply")}
                  onReplyAll={() => startReply("replyAll")}
                  onForward={() => startReply("forward")}
                  onArchive={() =>
                    readerId && runAction(readerId, "archive", reader?.fromEmail)
                  }
                  onDelete={() =>
                    readerId && runAction(readerId, "trash", reader?.fromEmail)
                  }
                />
              </div>
            </header>

            <div className="flex-1 overflow-y-auto">
              {!reader ? (
                <p className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</p>
              ) : (
                <>
                  <div className="border-b border-[var(--border)] px-6 py-4">
                    <div className="flex items-start gap-3">
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                        style={{
                          backgroundColor:
                            reader.guide?.color ?? "var(--primary)",
                        }}
                      >
                        {mailInitial(reader.fromName || reader.fromEmail)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{reader.fromName}</div>
                        <div className="truncate text-sm text-[var(--muted)]">
                          {reader.fromEmail}
                        </div>
                        {reader.receivedAt ? (
                          <div className="mt-0.5 text-xs text-[var(--muted)]">
                            {formatMailTime(reader.receivedAt)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {reader.guide ? (
                      <ReaderGuideBar
                        guide={reader.guide}
                        onTeach={(a) =>
                          teachSender(
                            reader.fromEmail,
                            a,
                            readerId ?? undefined,
                          )
                        }
                      />
                    ) : null}
                    <AssistBar
                      reader={reader}
                      drafting={drafting}
                      onDraft={draftReply}
                      rsvping={rsvping}
                      onRsvp={rsvp}
                      onUnsubscribe={
                        readerId
                          ? () => unsubscribe(readerId, reader?.fromEmail)
                          : undefined
                      }
                      onDelegate={
                        readerId
                          ? () => openDelegate(readerId, reader?.subject)
                          : undefined
                      }
                      onSchedule={
                        readerId && reader
                          ? () =>
                              openSchedule(
                                readerId,
                                reader.subject,
                                reader.guide?.ask,
                                reader.fromName,
                              )
                          : undefined
                      }
                    />
                  </div>

                  <div className="px-6 py-5">
                    {safeHtml ? (
                      <div
                        className="prose prose-sm max-w-none text-[var(--fg)] dark:prose-invert"
                        dangerouslySetInnerHTML={{ __html: safeHtml }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                        {reader.textBody || reader.subject}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </main>
      </>
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}

function DesktopMailRow({
  item,
  selected,
  busy,
  showGuide,
  logicMode,
  onOpen,
  onArchive,
  onDelete,
  chips,
  checked,
  onToggleSelect,
  onTeach,
  dense,
}: {
  item: EmailItem;
  selected: boolean;
  busy?: boolean;
  showGuide: boolean;
  logicMode?: boolean;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete: () => void;
  chips?: ReactNode;
  checked?: boolean;
  onToggleSelect?: () => void;
  onTeach?: (action: TriageAction) => void;
  /** Compact: hide the snippet, tighten padding. */
  dense?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const g = item.guide;
  const showActions = (selected || hovered) && !busy;

  return (
    <li
      className="group relative border-b border-[var(--border)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <article
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        className={`mail-row cursor-pointer pr-14 transition-colors ${
          selected ? "bg-[var(--brand-soft)]" : ""
        } ${checked ? "bg-[var(--primary-soft,rgba(52,152,217,0.1))]" : ""} ${
          busy ? "opacity-50" : ""
        } ${item.isUnread ? "unread" : ""}`}
      >
        {onToggleSelect && (hovered || checked) ? (
          <button
            type="button"
            aria-label={checked ? "Deselect" : "Select"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect();
            }}
            className={`mr-1.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded-full border-2 ${
              checked
                ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                : "border-[var(--muted)]"
            }`}
          >
            {checked ? <Check className="h-2.5 w-2.5" /> : null}
          </button>
        ) : (
          <span
            className={`mail-unread-dot ${item.isUnread ? "" : "empty"}`}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="mail-from truncate text-[13px] text-[var(--fg-strong)]">
              {item.fromName || item.fromEmail}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              {formatMailTime(item.receivedAt)}
            </span>
          </div>
          {dense ? (
            <div className="flex items-baseline gap-1.5 truncate text-[12px] leading-snug">
              {g?.category ? (
                <span className="shrink-0 rounded bg-[var(--card)] px-1 text-[9px] font-semibold text-[var(--muted)]">
                  {g.category}
                </span>
              ) : null}
              {g?.task ? (
                <span
                  className="shrink-0 font-semibold"
                  style={{ color: g.color }}
                >
                  {g.task}
                </span>
              ) : null}
              <span className="truncate text-[var(--muted)]">
                {item.subject}
              </span>
            </div>
          ) : (
            <>
              <div className="mail-subject truncate text-[12px] leading-snug">
                {item.subject}
              </div>
              <div className="truncate text-[11px] leading-snug text-[var(--muted)]">
                {item.snippet}
              </div>
            </>
          )}
          {showGuide && g && (!dense || logicMode) ? (
            <LogicExplain guide={g} expanded={logicMode} onTeach={onTeach} />
          ) : null}
          {chips}
        </div>
      </article>

      {showActions ? (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {onArchive ? (
            <IconButton
              label="Archive"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
            >
              <Archive className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          <IconButton
            label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ) : null}
    </li>
  );
}

function ReaderToolbar({
  disabled,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
}: {
  disabled?: boolean;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ToolbarButton disabled={disabled} label="Reply" onClick={onReply}>
        <Reply className="h-4 w-4" />
        <span>Reply</span>
      </ToolbarButton>
      <ToolbarButton disabled={disabled} label="Reply all" onClick={onReplyAll}>
        <ReplyAll className="h-4 w-4" />
        <span>Reply all</span>
      </ToolbarButton>
      <ToolbarButton disabled={disabled} label="Forward" onClick={onForward}>
        <Forward className="h-4 w-4" />
        <span>Forward</span>
      </ToolbarButton>
      <div className="mx-1 h-5 w-px bg-[var(--border)]" />
      <ToolbarButton disabled={disabled} label="Archive" onClick={onArchive}>
        <Archive className="h-4 w-4" />
        <span>Archive</span>
      </ToolbarButton>
      <ToolbarButton disabled={disabled} label="Delete" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
        <span>Delete</span>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--fg)] hover:bg-[var(--row-hover)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--card)] hover:text-[var(--fg)]"
    >
      {children}
    </button>
  );
}

function EmptyList({ text }: { text: string }) {
  return (
    <p className="py-16 text-center text-sm text-[var(--muted)]">{text}</p>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-md bg-[#1e242b] px-4 py-2.5 text-xs text-white shadow-lg">
      {message}
    </div>
  );
}
