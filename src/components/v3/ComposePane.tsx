"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Compose, type ComposeMode } from "@/components/v2/Compose";
import type { CommandResult } from "@/lib/v2/commands/types";
import type { ReaderComposeIntent } from "@/components/v2/Reader";

function modeFromIntent(intent?: ReaderComposeIntent): ComposeMode {
  return intent?.mode ?? "send";
}

export function ComposePane({
  intent,
  providerConversationId,
  onClose,
  onSent,
}: {
  intent?: ReaderComposeIntent;
  providerConversationId?: string;
  onClose: () => void;
  onSent: (result: CommandResult) => void;
}) {
  const mode = modeFromIntent(intent);
  const title =
    mode === "replyAll" ? "Reply all" : mode[0].toUpperCase() + mode.slice(1);

  return (
    <aside
      className="mail-compose"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mail-compose-title"
    >
      <header className="mail-compose-header">
        <h2 id="mail-compose-title">{title}</h2>
        <button type="button" className="mail-close mail-focus-ring" aria-label="Close compose" onClick={onClose}>
          <X aria-hidden />
        </button>
      </header>
      <Compose
        mode={mode}
        providerConversationId={providerConversationId}
        onCancel={onClose}
        onComplete={onSent}
      />
    </aside>
  );
}
