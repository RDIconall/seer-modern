"use client";

import DOMPurify from "isomorphic-dompurify";
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
import { logoutMobile } from "@/app/actions";
import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import { CardStack } from "@/components/inbox/CardStack";
import { ComposePanel } from "@/components/inbox/ComposePanel";
import { useMailbox } from "@/lib/inbox/use-mailbox";
import {
  buildCardDeck,
  ensureRe,
  formatMailTime,
  mailInitial,
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
    load,
    runAction,
    bulkSection,
    teachSender,
    openReader,
    closeReader,
    startCompose,
    startReply,
  } = useMailbox();

  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardDeck = useMemo(() => buildCardDeck(triage), [triage]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

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

  if (compose) {
    return (
      <ComposePanel
        draft={compose}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null);
          closeReader();
          setToast("Message sent");
          if (tab === "sent") load();
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
        <header className="flex items-center gap-1 border-b border-[var(--border)] px-1 py-1">
          <IconBtn onClick={closeReader} label="Back">
            <ChevronLeft className="h-6 w-6" />
          </IconBtn>
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[15px] font-medium">
              {reader?.subject ?? "…"}
            </div>
          </div>
          <IconBtn
            disabled={busyId === readerId}
            onClick={() => runAction(readerId, "archive")}
            label="Archive"
          >
            <Archive className="h-5 w-5" />
          </IconBtn>
          <IconBtn
            disabled={busyId === readerId}
            onClick={() => runAction(readerId, "trash")}
            label="Delete"
          >
            <Trash2 className="h-5 w-5" />
          </IconBtn>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-start gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                style={{ backgroundColor: g?.color ?? "var(--primary)" }}
              >
                {mailInitial(reader?.fromName ?? "?")}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {reader?.fromName ?? "…"}
                </div>
                <div className="truncate text-xs text-[var(--muted)]">
                  {reader?.fromEmail}
                </div>
              </div>
            </div>
            {g ? (
              <p
                className="mt-3 text-xs font-medium"
                style={{ color: g.color }}
              >
                {g.instruction}
              </p>
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
      {drawer ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
          <nav className="absolute inset-y-0 left-0 flex w-[82%] max-w-xs flex-col bg-[var(--bg)] pt-[var(--safe-top)] shadow-xl">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <div className="text-lg font-medium text-[var(--primary)]">
                Inbox Pilot
              </div>
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                {accountEmail}
              </div>
            </div>
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

      <header className="sticky top-0 z-10 bg-[var(--bg)] px-2 pb-1 pt-2">
        {searchOpen ? (
          <form
            className="flex items-center gap-1 rounded-full bg-[var(--card)] px-2 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
          >
            <IconBtn onClick={closeSearch} label="Close search">
              <ChevronLeft className="h-6 w-6" />
            </IconBtn>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search in mail"
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            />
            {search ? (
              <IconBtn
                onClick={() => {
                  setSearch("");
                  setQuery("");
                }}
                label="Clear"
              >
                <X className="h-5 w-5" />
              </IconBtn>
            ) : null}
          </form>
        ) : (
          <div className="flex items-center gap-1 rounded-full bg-[var(--card)] px-1 py-1">
            <IconBtn onClick={() => setDrawer(true)} label="Menu">
              <Menu className="h-5 w-5" />
            </IconBtn>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="min-w-0 flex-1 truncate px-1 text-left text-[15px] text-[var(--muted)]"
            >
              Search in {FOLDER_LABEL[tab].toLowerCase()}
            </button>
            <IconBtn onClick={load} disabled={loading} label="Refresh">
              <RefreshCw
                className={`h-5 w-5 ${loading ? "animate-spin" : ""}`}
              />
            </IconBtn>
            <div
              className="mr-1 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)] text-xs font-semibold text-white"
              title={accountEmail}
            >
              {mailInitial(accountEmail)}
            </div>
          </div>
        )}
        {tab !== "cards" ? (
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <h1 className="text-xl font-normal tracking-tight">
              {query ? "Search results" : FOLDER_LABEL[tab]}
            </h1>
            {tab !== "triage" && mailbox ? (
              <span className="text-xs text-[var(--muted)]">
                {mailbox.count}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <main
        className={`flex flex-1 flex-col overflow-auto pb-24 ${
          tab === "cards" ? "" : ""
        }`}
      >
        {error ? (
          <p className="mx-4 my-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
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
            items={cardDeck}
            busyId={busyId}
            onOpen={openReader}
            onAction={runAction}
            onReply={replyFromCard}
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
                  showGuide={false}
                  busy={busyId === item.id}
                  onOpen={() => openReader(item.id)}
                  onArchive={
                    tab === "inbox"
                      ? () => runAction(item.id, "archive")
                      : undefined
                  }
                  onDelete={() => runAction(item.id, "trash")}
                />
              ))}
            </ul>
          )
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
                  busy={busyId === item.id}
                  onOpen={() => openReader(item.id)}
                  onArchive={() => runAction(item.id, "archive")}
                  onDelete={() => runAction(item.id, "trash")}
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
                      busy={busyId === item.id}
                      onOpen={() => openReader(item.id)}
                      onArchive={() => runAction(item.id, "archive")}
                      onDelete={() => runAction(item.id, "trash")}
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
            icon={<Inbox className="h-5 w-5" />}
            onClick={() => {
              if (tab === "triage" || tab === "cards") setTab("inbox");
            }}
          />
          <BottomNavItem
            active={tab === "cards"}
            label="Cards"
            icon={<Layers className="h-5 w-5" />}
            onClick={() => selectFolder("cards")}
          />
          <BottomNavItem
            active={searchOpen}
            label="Search"
            icon={<Search className="h-5 w-5" />}
            onClick={() => setSearchOpen(true)}
          />
          <BottomNavItem
            active={tab === "triage"}
            label="Triage"
            icon={<ListFilter className="h-5 w-5" />}
            onClick={() => selectFolder("triage")}
          />
        </div>
      </nav>

      {tab !== "cards" ? (
        <button
          type="button"
          onClick={startCompose}
          className="fixed bottom-[calc(4.25rem+var(--safe-bottom))] right-4 z-30 flex items-center gap-2 rounded-2xl bg-[var(--card)] px-4 py-3.5 text-sm font-medium text-[var(--primary)] shadow-md ring-1 ring-black/5 dark:ring-white/10"
          aria-label="Compose"
        >
          <PenSquare className="h-5 w-5" />
          Compose
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
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--fg)] disabled:opacity-40 active:bg-black/5 dark:active:bg-white/10"
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
      className={`flex w-full items-center gap-4 rounded-r-full px-5 py-3 text-sm ${
        active
          ? "bg-[#d3e3fd] font-medium text-[#041e49] dark:bg-[#004a77] dark:text-[#c2e7ff]"
          : "text-[var(--fg)]"
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
      className={`flex flex-col items-center gap-0.5 py-2 text-[10px] ${
        active ? "text-[var(--primary)]" : "text-[var(--muted)]"
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
    <div className="flex items-center justify-between bg-[var(--card)] px-4 py-2">
      <h2
        className="text-xs font-medium uppercase tracking-wide"
        style={{ color: color ?? "var(--muted)" }}
      >
        {label}
      </h2>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="text-[11px] font-medium text-[var(--primary)]"
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
    <div className="fixed bottom-[calc(5.5rem+var(--safe-bottom))] left-1/2 z-50 max-w-[90%] -translate-x-1/2 rounded bg-[#323232] px-4 py-2.5 text-xs text-white shadow-lg">
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
}: {
  item: EmailItem;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete: () => void;
  busy?: boolean;
  chips?: ReactNode;
  showGuide: boolean;
}) {
  const g = item.guide;
  const accent = g?.color ?? "#7baaf7";
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
      <div className="absolute inset-y-0 left-0 flex w-24 items-center justify-center bg-[#0b8043] text-white">
        <Archive className="h-5 w-5" />
      </div>
      <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-[#d93025] text-white">
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
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
          style={{ backgroundColor: accent }}
        >
          {mailInitial(item.fromName || item.fromEmail)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="mail-from truncate text-[14px]">
              {item.fromName || item.fromEmail}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              {formatMailTime(item.receivedAt)}
            </span>
          </div>
          <div className="mail-subject truncate text-[13px] leading-snug">
            {item.subject}
          </div>
          <div className="truncate text-[12px] leading-snug text-[var(--muted)]">
            {item.snippet}
          </div>
          {showGuide && g ? (
            <div
              className="mt-1 truncate text-[11px] font-medium"
              style={{ color: g.color }}
            >
              {g.instruction}
            </div>
          ) : null}
          {chips}
        </div>
      </article>
    </li>
  );
}
