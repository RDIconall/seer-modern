"use client";

import DOMPurify from "dompurify";
import {
  Archive,
  ChevronLeft,
  Forward,
  Inbox,
  Layers,
  ListFilter,
  LogOut,
  Menu,
  PenSquare,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import { logoutMobile } from "@/app/actions";
import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import { CardStack } from "@/components/inbox/CardStack";
import { ComposePanel } from "@/components/inbox/ComposePanel";
import { DelegateSheet } from "@/components/inbox/DelegateSheet";
import { AssistBar } from "@/components/inbox/AssistBar";
import {
  LogicExplain,
  LogicToggle,
  ReaderGuideBar,
} from "@/components/inbox/LogicExplain";
import { SettingsPanel } from "@/components/inbox/SettingsPanel";
import { useMailbox } from "@/lib/inbox/use-mailbox";
import {
  buildDeckCards,
  ensureRe,
  formatMailTime,
  primaryMailAction,
  type EmailItem,
  type ViewTab,
} from "@/lib/inbox/types";

const QUICK_ACTIONS: TriageAction[] = [
  "respond",
  "read_and_archive",
  "delete_now",
  "unsubscribe",
  "act_today",
];

const FOLDER_LABEL: Record<ViewTab, string> = {
  inbox: "Inbox",
  sent: "Sent",
  trash: "Trash",
  triage: "Triage",
  cards: "Cards",
};

export function MobileMailApp() {
  const {
    tab,
    setTab,
    selectFolder: hookSelectFolder,
    triage,
    mailbox,
    listItems,
    error,
    loading,
    search,
    setSearch,
    query,
    setQuery,
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
    bulkSection,
    unsubscribe,
    teachSender,
    openReader,
    closeReader,
    startCompose,
    startReply,
    draftReply,
    drafting,
    rsvp,
    rsvping,
  } = useMailbox();

  const searchParams = useSearchParams();
  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logicMode, setLogicMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const deckCards = useMemo(() => buildDeckCards(triage), [triage]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (searchParams.get("settings") === "1") setSettingsOpen(true);
  }, [searchParams]);

  const selectFolder = (next: ViewTab) => {
    hookSelectFolder(next);
    setDrawer(false);
    setSearchOpen(false);
  };


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

  const closeSearch = () => {
    setSearchOpen(false);
    setSearch("");
    setQuery("");
  };

  if (settingsOpen) {
    return (
      <SettingsPanel
        mobile
        onClose={() => setSettingsOpen(false)}
        onAccountsChanged={() => {
          refreshIdentity();
          load();
        }}
      />
    );
  }

  if (compose) {
    const wasHandoff = compose.archiveOriginal;
    return (
      <ComposePanel
        draft={compose}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null);
          closeReader();
          setToast(wasHandoff ? "Handed off — original archived" : "Message sent");
          if (tab === "sent" || wasHandoff) load();
        }}
      />
    );
  }

  if (readerId) {
    const g = reader?.guide;
    const safeHtml = reader?.htmlBody
      ? DOMPurify.sanitize(reader.htmlBody)
      : "";
    return (
      <div className="app-shell fixed inset-0 z-50 flex flex-col bg-[var(--bg)]">
        {delegateFor ? (
          <DelegateSheet
            subject={delegateFor.subject}
            busy={delegating}
            onConfirm={confirmDelegate}
            onClose={closeDelegate}
          />
        ) : null}
        <header className="outlook-header flex items-center gap-1 px-1 py-1.5 shadow-sm">
          <IconBtn onClick={closeReader} label="Back" light>
            <ChevronLeft className="h-6 w-6" />
          </IconBtn>
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[16px] font-semibold text-white">
              {reader?.subject ?? "…"}
            </div>
          </div>
          <IconBtn
            disabled={busyId === readerId}
            onClick={() => runAction(readerId, "archive", reader?.fromEmail)}
            label="Archive"
            light
          >
            <Archive className="h-5 w-5" />
          </IconBtn>
          <IconBtn
            disabled={busyId === readerId}
            onClick={() => runAction(readerId, "trash", reader?.fromEmail)}
            label="Delete"
            light
          >
            <Trash2 className="h-5 w-5" />
          </IconBtn>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-start gap-3">
              <span
                className={`mail-unread-dot mt-2 ${reader ? "" : "empty"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-[var(--fg-strong)]">
                  {reader?.fromName ?? "…"}
                </div>
                <div className="truncate text-xs text-[var(--muted)]">
                  {reader?.fromEmail}
                </div>
              </div>
            </div>
            {g ? <ReaderGuideBar guide={g} /> : null}
            {reader ? (
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
              />
            ) : null}
          </div>
          <div className="px-4 py-4">
            {!reader ? (
              <p className="text-sm text-[var(--muted)]">Loading…</p>
            ) : safeHtml ? (
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
        </div>

        {reader ? (
          <footer className="flex items-center justify-around border-t border-[var(--border)] px-2 py-2 bottom-nav">
            <FooterAction
              icon={<Reply className="h-5 w-5" />}
              label="Reply"
              onClick={() => startReply("reply")}
            />
            <FooterAction
              icon={<ReplyAll className="h-5 w-5" />}
              label="Reply all"
              onClick={() => startReply("replyAll")}
            />
            <FooterAction
              icon={<Forward className="h-5 w-5" />}
              label="Forward"
              onClick={() => startReply("forward")}
            />
          </footer>
        ) : null}
        {toast ? <Toast message={toast} /> : null}
      </div>
    );
  }

  return (
    <div className="app-shell mx-auto flex min-h-[100dvh] max-w-lg flex-col bg-[var(--bg)] text-[var(--fg)]">
      {delegateFor ? (
        <DelegateSheet
          subject={delegateFor.subject}
          busy={delegating}
          onConfirm={confirmDelegate}
          onClose={closeDelegate}
        />
      ) : null}
      {drawer ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
          <nav className="absolute inset-y-0 left-0 flex w-[82%] max-w-xs flex-col bg-[var(--bg)] pt-[var(--safe-top)] shadow-xl">
            <button
              type="button"
              onClick={() => {
                setDrawer(false);
                setSettingsOpen(true);
              }}
              className="border-b border-[var(--border)] px-5 py-4 text-left"
            >
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/seer-mark.png" alt="" width={30} height={30} />
                <span className="seer-brand text-xl">Seer</span>
              </div>
              <div className="seer-tagline mt-0.5 text-[11px]">Work smarter</div>
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                {accountEmail}
              </div>
              {accountLabel ? (
                <div className="mt-0.5 text-[11px] text-[var(--primary)]">
                  {accountLabel} · Tap for settings
                </div>
              ) : (
                <div className="mt-0.5 text-[11px] text-[var(--primary)]">
                  Tap for settings & accounts
                </div>
              )}
            </button>
            <div className="flex-1 overflow-auto py-2">
              <DrawerItem
                active={tab === "inbox"}
                icon={<Inbox className="h-5 w-5" />}
                label="Inbox"
                onClick={() => selectFolder("inbox")}
              />
              <DrawerItem
                active={tab === "sent"}
                icon={<Send className="h-5 w-5" />}
                label="Sent"
                onClick={() => selectFolder("sent")}
              />
              <DrawerItem
                active={tab === "trash"}
                icon={<Trash2 className="h-5 w-5" />}
                label="Trash"
                onClick={() => selectFolder("trash")}
              />
              <DrawerItem
                active={tab === "cards"}
                icon={<Layers className="h-5 w-5" />}
                label="Cards"
                onClick={() => selectFolder("cards")}
              />
              <DrawerItem
                active={tab === "triage"}
                icon={<ListFilter className="h-5 w-5" />}
                label="Triage"
                onClick={() => selectFolder("triage")}
              />
              <DrawerItem
                active={false}
                icon={<Settings className="h-5 w-5" />}
                label="Settings"
                onClick={() => {
                  setDrawer(false);
                  setSettingsOpen(true);
                }}
              />
            </div>
            <form
              action={logoutMobile}
              className="border-t border-[var(--border)] px-2 py-2 bottom-nav"
            >
              <button
                type="submit"
                className="flex w-full items-center gap-4 rounded-r-full px-4 py-3 text-sm text-[var(--muted)]"
              >
                <LogOut className="h-5 w-5" />
                Sign out
              </button>
            </form>
          </nav>
        </div>
      ) : null}

      <header className="sticky top-0 z-10 outlook-header shadow-sm">
        {searchOpen ? (
          <form
            className="flex items-center gap-1 px-2 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
          >
            <IconBtn onClick={closeSearch} label="Close search" light>
              <ChevronLeft className="h-6 w-6" />
            </IconBtn>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 rounded bg-white/15 px-3 py-2 text-[15px] text-white outline-none placeholder:text-white/70"
            />
            {search ? (
              <IconBtn
                onClick={() => {
                  setSearch("");
                  setQuery("");
                }}
                label="Clear"
                light
              >
                <X className="h-5 w-5" />
              </IconBtn>
            ) : null}
          </form>
        ) : (
          <div className="flex items-center gap-0.5 px-1 py-1.5">
            <IconBtn onClick={() => setDrawer(true)} label="Menu" light>
              <Menu className="h-5 w-5" />
            </IconBtn>
            <h1 className="min-w-0 flex-1 truncate px-1 text-[20px] font-semibold tracking-tight text-white">
              {query
                ? "Search results"
                : tab === "cards"
                  ? "Cards"
                  : tab === "triage"
                    ? "Triage"
                    : FOLDER_LABEL[tab]}
            </h1>
            {(tab === "inbox" || tab === "triage" || Boolean(query)) && (
              <LogicToggle
                on={logicMode}
                onToggle={() => setLogicMode((v) => !v)}
              />
            )}
            <IconBtn onClick={load} disabled={loading} label="Refresh" light>
              <RefreshCw
                className={`h-5 w-5 ${loading ? "animate-spin" : ""}`}
              />
            </IconBtn>
            <IconBtn
              onClick={() => setSearchOpen(true)}
              label="Search"
              light
            >
              <Search className="h-5 w-5" />
            </IconBtn>
            <IconBtn
              onClick={() => setSettingsOpen(true)}
              label="Settings"
              light
            >
              <Settings className="h-5 w-5" />
            </IconBtn>
          </div>
        )}
      </header>

      <main
        className={`flex flex-1 flex-col overflow-auto pb-24 ${
          tab === "cards" ? "seer-deck-bg" : ""
        }`}
      >
        {error ? (
          <p className="mx-4 my-3 rounded-lg bg-[#d63b2f]/10 px-3 py-2 text-sm text-[#d63b2f]">
            {error}
          </p>
        ) : null}

        {loading &&
        (((tab === "triage" || tab === "cards") && !triage) ||
          (tab !== "triage" && tab !== "cards" && !mailbox)) ? (
          <p className="py-16 text-center text-sm text-[var(--muted)]">
            Loading…
          </p>
        ) : null}

        {tab === "cards" && triage ? (
          <CardStack
            deck={deckCards}
            busyId={busyId}
            onOpen={openReader}
            onAction={runAction}
            onBulk={bulkSection}
            onReply={replyFromCard}
            onSnooze={snooze}
            onDelegate={openDelegate}
            onEmptyRefresh={load}
          />
        ) : null}

        {tab !== "triage" && tab !== "cards" && mailbox ? (
          listItems.length === 0 ? (
            <EmptyState
              text={
                query
                  ? "No matches"
                  : tab === "inbox"
                    ? "Your inbox is empty"
                    : `${FOLDER_LABEL[tab]} is empty`
              }
            />
          ) : (
            <ul>
              {listItems.map((item) => (
                <SwipeMailRow
                  key={item.id}
                  item={item}
                  showGuide={tab === "inbox" || Boolean(query)}
                  logicMode={logicMode}
                  busy={busyId === item.id}
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
          )
        ) : null}

        {tab === "triage" && triage ? (
          <div className="border-b border-[var(--border)] bg-[var(--card)] px-4 py-2">
            <p className="text-[12px] text-[var(--muted)]">
              {triage.assistant
                ? `Gemini ${triage.assistant.gemini} · rules ${triage.assistant.rules}${triage.assistant.learned ? ` · learned ${triage.assistant.learned}` : ""} · taught ${triage.assistant.override}${triage.assistant.cached ? ` · cached ${triage.assistant.cached}` : ""} · your call ${triage.assistant.needsReview}`
                : triage.history
                  ? `${triage.history.engagedCount} people you email · ${triage.history.contactCount} contacts`
                  : "Gemini-first triage — you are last resort"}
            </p>
            {triage.assistant?.error ? (
              <p className="mt-0.5 text-[11px] font-medium text-[#d63b2f]">
                Gemini offline — rules only: {triage.assistant.error.slice(0, 120)}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === "triage" && triage && triage.count === 0 ? (
          <EmptyState text="Nothing to triage" />
        ) : null}

        {tab === "triage" && triage && triage.needsReview.length > 0 ? (
          <section>
            <SectionHeader
              label={`Needs your call · ${triage.needsReview.length}`}
            />
            <ul>
              {triage.needsReview.map((item) => (
                <SwipeMailRow
                  key={item.id}
                  item={item}
                  showGuide
                  logicMode={logicMode}
                  busy={busyId === item.id}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive", item.fromEmail)}
                  onDelete={() => runAction(item.id, "trash", item.fromEmail)}
                  chips={
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {QUICK_ACTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            teachSender(item.fromEmail, a);
                          }}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                          style={{ backgroundColor: ACTION_META[a].color }}
                        >
                          {ACTION_META[a].short}
                        </button>
                      ))}
                    </div>
                  }
                />
              ))}
            </ul>
          </section>
        ) : null}

        {tab === "triage"
          ? triage?.sections.map((section) => (
              <section key={section.action}>
                <SectionHeader
                  label={`${section.label} · ${section.items.length}`}
                  color={section.color}
                  actionLabel={section.bulkLabel}
                  onAction={() =>
                    bulkSection(section, primaryMailAction(section.action))
                  }
                />
                <ul>
                  {section.items.map((item) => (
                    <SwipeMailRow
                      key={item.id}
                      item={item}
                      showGuide
                      logicMode={logicMode}
                      busy={busyId === item.id}
                      onOpen={() => openReader(item.id)}
                      onArchive={() => runAction(item.id, "archive", item.fromEmail)}
                      onDelete={() => runAction(item.id, "trash", item.fromEmail)}
                    />
                  ))}
                </ul>
              </section>
            ))
          : null}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-20 mx-auto max-w-lg border-t border-[var(--border)] bg-[var(--bg)] bottom-nav">
        <div className="grid grid-cols-4">
          <BottomNavItem
            active={tab === "inbox" || tab === "sent" || tab === "trash"}
            label="Mail"
            icon={<Inbox className="h-6 w-6" />}
            onClick={() => {
              if (tab === "triage" || tab === "cards") setTab("inbox");
            }}
          />
          <BottomNavItem
            active={tab === "cards"}
            label="Cards"
            icon={<Layers className="h-6 w-6" />}
            onClick={() => selectFolder("cards")}
          />
          <BottomNavItem
            active={searchOpen}
            label="Search"
            icon={<Search className="h-6 w-6" />}
            onClick={() => setSearchOpen(true)}
          />
          <BottomNavItem
            active={tab === "triage"}
            label="Triage"
            icon={<ListFilter className="h-6 w-6" />}
            onClick={() => selectFolder("triage")}
          />
        </div>
      </nav>

      {tab !== "cards" ? (
        <button
          type="button"
          onClick={startCompose}
          className="fixed bottom-[calc(4.5rem+var(--safe-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--brand)] text-white shadow-lg"
          aria-label="Compose"
        >
          <PenSquare className="h-6 w-6" />
        </button>
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  label,
  disabled,
  light,
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  disabled?: boolean;
  light?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-full disabled:opacity-40 ${
        light
          ? "text-white active:bg-white/15"
          : "text-[var(--fg)] active:bg-black/5 dark:active:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function DrawerItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-4 px-5 py-3.5 text-sm ${
        active
          ? "border-l-4 border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--fg-strong)]"
          : "border-l-4 border-transparent text-[var(--fg)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function BottomNavItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${
        active
          ? "font-semibold text-[var(--brand)]"
          : "text-[var(--muted)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function FooterAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col items-center gap-0.5 py-1 text-[10px] text-[var(--fg)]"
    >
      {icon}
      {label}
    </button>
  );
}

function SectionHeader({
  label,
  color,
  actionLabel,
  onAction,
}: {
  label: string;
  color?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 py-2.5">
      <h2
        className="flex items-center gap-1.5 text-[13px] font-semibold"
        style={{ color: color ?? "var(--fg-strong)" }}
      >
        {color ? (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden
          />
        ) : null}
        {label}
      </h2>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="text-[12px] font-semibold text-[var(--primary)]"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="py-20 text-center text-sm text-[var(--muted)]">{text}</p>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-[calc(5.5rem+var(--safe-bottom))] left-1/2 z-50 max-w-[90%] -translate-x-1/2 rounded bg-[#1e242b] px-4 py-2.5 text-xs text-white shadow-lg">
      {message}
    </div>
  );
}

function SwipeMailRow({
  item,
  onOpen,
  onArchive,
  onDelete,
  busy,
  chips,
  showGuide,
  logicMode,
}: {
  item: EmailItem;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete: () => void;
  busy?: boolean;
  chips?: ReactNode;
  showGuide: boolean;
  logicMode?: boolean;
}) {
  const g = item.guide;
  const startX = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);

  const onTouchStart = (e: TouchEvent) => {
    startX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (startX.current == null) return;
    const dx = (e.touches[0]?.clientX ?? startX.current) - startX.current;
    setOffset(Math.max(-96, Math.min(96, dx)));
  };
  const onTouchEnd = () => {
    if (offset <= -64) onDelete();
    else if (offset >= 64 && onArchive) onArchive();
    setOffset(0);
    startX.current = null;
  };

  return (
    <li className="relative overflow-hidden">
      <div className="absolute inset-y-0 left-0 flex w-24 items-center justify-center bg-[#76ab19] text-white">
        <Archive className="h-5 w-5" />
      </div>
      <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-[#d63b2f] text-white">
        <Trash2 className="h-5 w-5" />
      </div>
      <article
        role="button"
        tabIndex={0}
        onClick={() => {
          if (Math.abs(offset) < 8) onOpen();
        }}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className={`mail-row ${item.isUnread ? "unread" : ""} ${
          busy ? "opacity-50" : ""
        }`}
        style={{ transform: `translateX(${offset}px)` }}
      >
        <span
          className={`mail-unread-dot ${item.isUnread ? "" : "empty"}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="mail-from truncate text-[15px] text-[var(--fg-strong)]">
              {item.fromName || item.fromEmail}
            </span>
            <span className="shrink-0 text-[12px] text-[var(--muted)]">
              {formatMailTime(item.receivedAt)}
            </span>
          </div>
          <div className="mail-subject truncate text-[14px] leading-snug text-[var(--fg)]">
            {item.subject}
          </div>
          <div className="truncate text-[13px] leading-snug text-[var(--muted)]">
            {item.snippet}
          </div>
          {showGuide && g ? (
            <LogicExplain guide={g} expanded={logicMode} />
          ) : null}
          {chips}
        </div>
      </article>
    </li>
  );
}
