"use client";

import * as React from "react";
import { useState } from "react";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { supportedActions, providerLabel, NATIVE_ONLY } from "@/lib/v2/client/actions";

/**
 * The action row for a conversation. It renders only the actions Seer performs
 * itself; provider-native-only work links out to the exact conversation. There
 * is no half-working button.
 */
export function ConversationActions({
  provider,
  nativeUrl,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onMove,
}: {
  provider: ProviderKind;
  nativeUrl: string;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onMove?: (destinationId: string) => void;
}) {
  const actions = supportedActions(provider);
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const loadFolders = async () => {
    if (folders) return;
    const response = await fetch("/api/v3/folders");
    if (!response.ok) return;
    const json = (await response.json()) as {
      folders?: { id: string; name: string }[];
    };
    setFolders(json.folders ?? []);
  };
  return (
    <div className="seer-actions" role="toolbar" aria-label="Conversation actions">
      {actions.includes("reply") && (
        <button type="button" onClick={onReply}>
          Reply
        </button>
      )}
      {actions.includes("replyAll") && (
        <button type="button" onClick={onReplyAll} aria-label="Reply all">
          Reply all
        </button>
      )}
      {actions.includes("forward") && (
        <button type="button" onClick={onForward}>
          Forward
        </button>
      )}
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
      {onMove ? (
        <label className="seer-move">
          <span className="sr-only">Move conversation</span>
          <select
            aria-label="Move conversation"
            value=""
            onFocus={() => void loadFolders()}
            onChange={(event) => {
              if (event.target.value) onMove(event.target.value);
            }}
          >
            <option value="">Move to…</option>
            {(folders ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <a href={nativeUrl} target="_blank" rel="noopener noreferrer">
        Open in {providerLabel(provider)}
      </a>
      <span
        className="seer-native-note"
        title={`For ${NATIVE_ONLY.join(", ")}, use the provider app`}
        aria-hidden
      />
    </div>
  );
}
