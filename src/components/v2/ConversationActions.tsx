"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { supportedActions, providerLabel, NATIVE_ONLY } from "@/lib/v2/client/actions";

/**
 * The action row for a conversation. Replying happens under the newest message,
 * so the row carries only what acts on the whole thread: the two verbs that
 * clear it, and one overflow for the rest. It renders only the actions Seer
 * performs itself; provider-native-only work links out to the exact
 * conversation. There is no half-working button.
 */
export function ConversationActions({
  provider,
  nativeUrl,
  onArchive,
  onDelete,
  onMove,
}: {
  provider: ProviderKind;
  nativeUrl: string;
  onArchive: () => void;
  onDelete: () => void;
  onMove?: (destinationId: string) => void;
}) {
  const actions = supportedActions(provider);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const wrap = useRef<HTMLDivElement | null>(null);

  const loadFolders = async () => {
    if (folders) return;
    const response = await fetch("/api/v3/folders");
    if (!response.ok) return;
    const json = (await response.json()) as {
      folders?: { id: string; name: string }[];
    };
    setFolders(json.folders ?? []);
  };

  useEffect(() => {
    if (!open) return;
    const onDocument = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div className="seer-actions" role="toolbar" aria-label="Conversation actions">
      {actions.includes("archive") && (
        <button type="button" onClick={onArchive}>
          Archive
        </button>
      )}
      {actions.includes("delete") && (
        <button type="button" onClick={onDelete}>
          Delete
        </button>
      )}

      <div className="seer-more" ref={wrap}>
        <button
          type="button"
          className="seer-more-toggle"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More actions"
          onClick={() => {
            setOpen((current) => !current);
            if (onMove) void loadFolders();
          }}
        >
          <MoreHorizontal aria-hidden />
          <span>More</span>
        </button>

        {open && (
          <div className="seer-more-menu" role="menu">
            {onMove ? (
              <div className="seer-more-group" role="group" aria-label="Move to">
                <p className="seer-more-heading">Move to</p>
                {(folders ?? []).length === 0 ? (
                  <p className="seer-more-empty">Loading folders…</p>
                ) : (
                  (folders ?? []).map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        onMove(folder.id);
                      }}
                    >
                      {folder.name}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            <a
              role="menuitem"
              href={nativeUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`For ${NATIVE_ONLY.join(", ")}, use the provider app`}
              onClick={() => setOpen(false)}
            >
              Open in {providerLabel(provider)}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
