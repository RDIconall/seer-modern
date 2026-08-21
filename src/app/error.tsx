"use client";

import * as React from "react";
import { useEffect } from "react";

/**
 * The client-fault boundary.
 *
 * Without one, a single bad render hands the whole app to the browser's
 * "Application error: a client-side exception has occurred" — a sentence that
 * names nothing, recovers nothing, and cannot be reported. Keep the fault
 * visible and the way back obvious: `reset()` re-renders the segment, which
 * clears a transient fault without losing the session, and a reload is the
 * blunt instrument behind it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[seer] client fault:", error);
  }, [error]);

  return (
    <main className="seer-fault" role="alert">
      <h1>Something in Seer stopped working</h1>
      <p className="seer-fault-message">{error.message || "Unknown error"}</p>
      {error.digest ? (
        <p className="seer-fault-digest tabular">Reference {error.digest}</p>
      ) : null}
      <div className="seer-fault-actions">
        <button type="button" className="mail-action mail-focus-ring" onClick={reset}>
          Try again
        </button>
        <button
          type="button"
          className="mail-focus-ring"
          onClick={() => window.location.reload()}
        >
          Reload Seer
        </button>
      </div>
      <p className="seer-fault-note">
        Your mail is untouched — this is the screen failing to draw, not an
        action that ran.
      </p>
    </main>
  );
}
