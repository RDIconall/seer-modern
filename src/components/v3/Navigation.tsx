"use client";

import * as React from "react";
import {
  Inbox,
  LayoutGrid,
  Mail,
  Send,
  Settings,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MailboxFolder } from "@/lib/v3/mailbox/types";

export type MailSection = MailboxFolder | "atlas" | "settings";

type NavigationItem = {
  id: MailSection;
  label: string;
  icon: LucideIcon;
};

const items: NavigationItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "trash", label: "Trash", icon: Trash2 },
  { id: "atlas", label: "Atlas", icon: LayoutGrid },
  { id: "settings", label: "Settings", icon: Settings },
];

function NavButton({
  item,
  active,
  onNavigate,
}: {
  item: NavigationItem;
  active: MailSection;
  onNavigate: (section: MailSection) => void;
}) {
  const Icon = item.icon;
  const isActive = active === item.id;
  return (
    <button
      type="button"
      className="mail-nav-item"
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      aria-label={item.label}
      onClick={() => onNavigate(item.id)}
    >
      <Icon className="mail-nav-icon" aria-hidden />
      <span className="mail-nav-label">{item.label}</span>
    </button>
  );
}

/**
 * Desktop rail and mobile bottom navigation share this item list and handlers.
 * CSS changes placement; navigation never forks the mail business logic.
 */
export function Navigation({
  active,
  onNavigate,
  onCompose,
  modalOpen,
}: {
  active: MailSection;
  onNavigate: (section: MailSection) => void;
  onCompose: () => void;
  modalOpen: boolean;
}) {
  return (
    <>
      <aside className="mail-navigation" aria-label="Mailbox navigation">
        <div className="mail-brand" aria-label="Seer mail">
          <Mail className="mail-brand-icon" aria-hidden />
          <span>Seer</span>
        </div>
        <button
          type="button"
          className="mail-compose-button mail-focus-ring"
          onClick={onCompose}
        >
          <span aria-hidden>＋</span>
          Compose
        </button>
        <nav className="mail-nav-list" aria-label="Folders and views">
          {items.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={active}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </aside>

      {!modalOpen && (
        <nav className="mail-bottom-nav" aria-label="Mobile mailbox navigation">
          {items.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={active}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      )}
      {!modalOpen && (
        <button
          type="button"
          className="mail-mobile-compose mail-focus-ring"
          aria-label="Compose new message"
          onClick={onCompose}
        >
          <span aria-hidden>＋</span>
          <span>Compose</span>
        </button>
      )}
    </>
  );
}
