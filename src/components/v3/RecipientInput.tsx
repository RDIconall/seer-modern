"use client";

import * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { ContactSuggestion } from "@/lib/v3/contacts/types";
import { SearchRequestGuard } from "./search-request";
import {
  addRecipient,
  commitAddressList,
  commitRawAddress,
  moveActiveIndex,
  pillLabel,
  removeLastRecipient,
  removeRecipient,
  type Recipient,
} from "./recipient-state";

const DEBOUNCE_MS = 150;

type ContactsResponse = {
  suggestions?: ContactSuggestion[];
  error?: string;
};

export function RecipientInput({
  id,
  labelledBy,
  recipients,
  onChange,
}: {
  id: string;
  labelledBy: string;
  recipients: Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(new SearchRequestGuard());
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      guard.current.cancel();
      setSuggestions([]);
      setActiveIndex(-1);
      setOpen(false);
      return;
    }

    const handle = window.setTimeout(() => {
      const token = guard.current.start();
      void fetch(`/api/v3/contacts?q=${encodeURIComponent(trimmed)}`, {
        signal: token.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const json = (await response.json()) as ContactsResponse;
          if (!response.ok) {
            // No active account answers 404. An empty list is the honest
            // result there; an error banner over the To field is not.
            if (response.status === 404) return [] as ContactSuggestion[];
            throw new Error(json.error ?? `contacts ${response.status}`);
          }
          return json.suggestions ?? [];
        })
        .then((rows) => {
          if (!guard.current.isCurrent(token)) return;
          setSuggestions(rows);
          setOpen(rows.length > 0);
          // Nothing is highlighted until the user arrows to it or clicks it.
          // Pre-selecting the first row would mean that typing a full address
          // and pressing Enter sends to whoever happened to be top of the
          // list instead — the one mistake a recipient field must not make.
          setActiveIndex(-1);
        })
        .catch(() => {
          if (!guard.current.isCurrent(token)) return;
          setSuggestions([]);
          setOpen(false);
          setActiveIndex(-1);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [query]);

  useEffect(() => () => guard.current.cancel(), []);

  function commitSuggestion(suggestion: ContactSuggestion) {
    onChange(
      addRecipient(recipients, {
        email: suggestion.email,
        displayName: suggestion.displayName,
      }),
    );
    setQuery("");
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    setError(null);
    inputRef.current?.focus();
  }

  function commitTyped() {
    const result = commitRawAddress(recipients, query);
    onChange(result.recipients);
    setError(result.error);
    if (!result.error && query.trim()) {
      setQuery("");
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setOpen(true);
      setActiveIndex((current) => moveActiveIndex(current, 1, suggestions.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.length === 0) return;
      setOpen(true);
      setActiveIndex((current) => moveActiveIndex(current, -1, suggestions.length));
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0 && suggestions[activeIndex]) {
        commitSuggestion(suggestions[activeIndex]);
        return;
      }
      commitTyped();
      return;
    }
    if (event.key === "Backspace" && query === "" && recipients.length > 0) {
      event.preventDefault();
      onChange(removeLastRecipient(recipients));
      setError(null);
      return;
    }
    if (event.key === "," || event.key === ";") {
      event.preventDefault();
      commitTyped();
    }
  }

  function onPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!/[,;\n\r]/.test(text)) return;
    event.preventDefault();
    const result = commitAddressList(recipients, `${query}${text}`);
    onChange(result.recipients);
    setError(result.error);
    if (!result.error) {
      setQuery("");
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  const activeId =
    open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div className="mail-recipient">
      <div className="mail-recipient-field">
        {recipients.map((recipient) => (
          <span key={recipient.email.toLowerCase()} className="mail-recipient-pill">
            <span className="mail-recipient-pill-label">{pillLabel(recipient)}</span>
            <button
              type="button"
              className="mail-recipient-pill-remove mail-focus-ring"
              aria-label={`Remove ${pillLabel(recipient)}`}
              onClick={() => {
                onChange(removeRecipient(recipients, recipient.email));
                setError(null);
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          className="mail-recipient-input mail-focus-ring"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-labelledby={labelledBy}
          placeholder={recipients.length === 0 ? "Type a name or email" : undefined}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            // Delay so a mousedown on an option can commit first.
            window.setTimeout(() => setOpen(false), 120);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul id={listId} className="mail-recipient-list" role="listbox">
          {suggestions.map((suggestion, index) => {
            const label = suggestion.displayName
              ? `${suggestion.displayName} <${suggestion.email}>`
              : suggestion.email;
            return (
              <li
                key={suggestion.email}
                id={`${listId}-option-${index}`}
                className="mail-recipient-option"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitSuggestion(suggestion);
                }}
              >
                {label}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="mail-recipient-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
