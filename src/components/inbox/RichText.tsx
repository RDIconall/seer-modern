"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
} from "lucide-react";

/**
 * RICH TEXT — a composer body that can hold a list.
 *
 * Every reply Seer drafts today goes out as one wall of plain text, which
 * is wrong for the mail actually being written here: a scope with three
 * bullets, a quote with figures, a handoff with two questions.
 *
 * The controls are not chrome — they exist only while the editor has focus,
 * and each is also a keystroke, so a fast reply never sees them. Output is
 * both HTML and a plaintext fallback, so a recipient on a text-only client
 * still gets a readable message.
 */

export type RichValue = { html: string; text: string };

const KEYS: Record<string, string> = { b: "bold", i: "italic", u: "underline" };

export function RichText({
  value,
  onChange,
  placeholder,
  autoFocus,
  minHeight = 160,
}: {
  value: RichValue;
  onChange: (v: RichValue) => void;
  placeholder?: string;
  autoFocus?: boolean;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  // Only seed the DOM when the editor is not the source of the change,
  // otherwise the caret jumps to the start on every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML !== value.html) el.innerHTML = value.html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    onChange({ html: el.innerHTML, text: toText(el) });
  }, [onChange]);

  const run = useCallback(
    (cmd: string, arg?: string) => {
      ref.current?.focus();
      document.execCommand(cmd, false, arg);
      emit();
    },
    [emit],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const cmd = KEYS[e.key.toLowerCase()];
    if (cmd) {
      e.preventDefault();
      run(cmd);
      return;
    }
    if (e.key.toLowerCase() === "k") {
      e.preventDefault();
      link();
    }
  }

  function link() {
    const url = window.prompt("Link to");
    if (!url) return;
    run("createLink", /^https?:|^mailto:/i.test(url) ? url : `https://${url}`);
  }

  // Paste as text: pasted Word and Outlook markup is the single largest
  // source of mail that renders differently for the recipient.
  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    emit();
  }

  const empty = !value.text.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        {empty && placeholder ? (
          <p className="pointer-events-none absolute left-0 top-0 text-[var(--nav-muted)]">
            {placeholder}
          </p>
        ) : null}
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label="Message body"
          contentEditable
          suppressContentEditableWarning
          autoFocus={autoFocus}
          onInput={emit}
          onBlur={() => {
            setFocused(false);
            emit();
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{ minHeight }}
          className="seer-read prose h-full w-full outline-none"
        />
      </div>

      {/* Appears on focus, goes away when you leave. Never at rest. */}
      <div
        className={`sticky bottom-0 -mx-1 flex items-center gap-0.5 border-t border-[var(--border)] bg-[var(--card)] px-1 pt-1 transition-opacity ${
          focused ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <Tool label="Bold" hint="⌘B" onClick={() => run("bold")}>
          <Bold className="h-4 w-4" />
        </Tool>
        <Tool label="Italic" hint="⌘I" onClick={() => run("italic")}>
          <Italic className="h-4 w-4" />
        </Tool>
        <Tool label="Strikethrough" onClick={() => run("strikeThrough")}>
          <Strikethrough className="h-4 w-4" />
        </Tool>
        <span className="mx-1 h-4 w-px bg-[var(--border)]" />
        <Tool label="Bulleted list" onClick={() => run("insertUnorderedList")}>
          <List className="h-4 w-4" />
        </Tool>
        <Tool label="Numbered list" onClick={() => run("insertOrderedList")}>
          <ListOrdered className="h-4 w-4" />
        </Tool>
        <Tool label="Quote" onClick={() => run("formatBlock", "blockquote")}>
          <Quote className="h-4 w-4" />
        </Tool>
        <Tool label="Link" hint="⌘K" onClick={link}>
          <Link2 className="h-4 w-4" />
        </Tool>
      </div>
    </div>
  );
}

function Tool({
  label,
  hint,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      // Mouse-down default would blur the editor and drop the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded text-[var(--nav-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
    >
      {children}
    </button>
  );
}

/**
 * Plaintext fallback. Not innerText — that loses list markers and collapses
 * blockquotes, which are exactly the structures worth sending.
 */
function toText(root: HTMLElement): string {
  const out: string[] = [];
  const walk = (node: Node, prefix = "") => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out.push(prefix + (n.textContent ?? ""));
        return;
      }
      if (!(n instanceof HTMLElement)) return;
      const tag = n.tagName.toLowerCase();
      if (tag === "br") {
        out.push("\n");
        return;
      }
      if (tag === "li") {
        const ordered = n.parentElement?.tagName.toLowerCase() === "ol";
        const idx = Array.from(n.parentElement?.children ?? []).indexOf(n) + 1;
        out.push("\n" + (ordered ? `${idx}. ` : "- "));
        walk(n);
        return;
      }
      if (tag === "blockquote") {
        out.push("\n");
        walk(n, "> ");
        out.push("\n");
        return;
      }
      if (tag === "a") {
        const href = n.getAttribute("href");
        walk(n);
        if (href && href !== n.textContent) out.push(` <${href}>`);
        return;
      }
      if (/^(div|p|ul|ol|h[1-6])$/.test(tag)) {
        out.push("\n");
        walk(n, prefix);
        return;
      }
      walk(n, prefix);
    });
  };
  walk(root);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}
