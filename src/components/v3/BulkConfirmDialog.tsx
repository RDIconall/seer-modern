"use client";

import * as React from "react";
import { useEffect, useRef } from "react";
import { EFFECT_LABEL, planSummary, type BulkPlan } from "./bulk-plan";

/**
 * The one question the Inbox asks before it acts on anything: is this the next
 * step you want to do? Nothing has run when this is on screen, and Escape or
 * "Go back" leaves every row exactly as it was.
 */
export function BulkConfirmDialog({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: BulkPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const deleting = plan.counts.delete.groups > 0;
  const lines = planSummary(plan);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // A delete is the one thing here that cannot be undone, so the safe button
    // takes focus when the plan contains one.
    (deleting ? cancelRef : confirmRef).current?.focus();
    return () => previous?.focus?.();
  }, [deleting]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The list behind answers to j, k and Escape; while this question is open
      // it is the only thing that hears the keyboard.
      event.stopPropagation();
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel]);

  return (
    <div
      className="bulk-confirm-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="bulk-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-confirm-title"
        aria-describedby="bulk-confirm-summary"
      >
        <h2 id="bulk-confirm-title">Is this the next step you want to do?</h2>
        <ul id="bulk-confirm-summary" className="bulk-confirm-summary">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {plan.heldBack > 0 ? (
          <p className="bulk-confirm-warning" role="note">
            Seer held {plan.heldBack === 1 ? "one of these" : `${plan.heldBack} of these`}{" "}
            back from deletion, because it looks personal or important. It will
            be deleted if you go ahead.
          </p>
        ) : null}
        <ul className="bulk-confirm-items" aria-label="What will happen">
          {plan.items.map((item) => (
            <li key={item.groupKey} data-effect={item.effect}>
              <span className="bulk-confirm-effect">{EFFECT_LABEL[item.effect]}</span>
              <span className="bulk-confirm-title">{item.title}</span>
              <span className="bulk-confirm-count tabular">
                {item.emails} {item.emails === 1 ? "email" : "emails"}
              </span>
              {item.effect === "finish" ? (
                <span className="bulk-confirm-text">{item.text}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            Go back
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="bulk-confirm-go"
            data-danger={deleting ? "true" : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : `Yes, do ${plan.items.length === 1 ? "this" : "these"}`}
          </button>
        </footer>
      </section>
    </div>
  );
}
