"use client";

import * as React from "react";
import { useEffect } from "react";

/**
 * The root-layout fault boundary. This one replaces the document, so it brings
 * its own <html> and <body> and cannot lean on the app's stylesheets — the
 * layout that would have loaded them is the thing that failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[seer] root fault:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          display: "grid",
          minHeight: "100vh",
          placeItems: "center",
          padding: "24px",
          background: "#f1f3f5",
          color: "#0b0d10",
          font: "15px/1.5 system-ui, sans-serif",
        }}
      >
        <main role="alert" style={{ maxWidth: "34rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "20px" }}>Seer could not start</h1>
          <p style={{ color: "#5b6570" }}>{error.message || "Unknown error"}</p>
          {error.digest ? (
            <p style={{ color: "#5b6570", fontSize: "13px" }}>
              Reference {error.digest}
            </p>
          ) : null}
          <div
            style={{
              display: "flex",
              gap: "8px",
              justifyContent: "center",
              marginTop: "16px",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                border: "1px solid #c9d1d8",
                borderRadius: "8px",
                padding: "8px 14px",
                background: "#fff",
                font: "inherit",
                fontWeight: 650,
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: "1px solid #c9d1d8",
                borderRadius: "8px",
                padding: "8px 14px",
                background: "#fff",
                font: "inherit",
              }}
            >
              Reload Seer
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
