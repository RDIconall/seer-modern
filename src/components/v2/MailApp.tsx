"use client";

import { useState } from "react";
import { useInboxView } from "./useInboxView";
import { Atlas } from "./Atlas";
import { Triage } from "./Triage";
import { WorthReading } from "./WorthReading";

/**
 * The one responsive Seer v2 application. Desktop and mobile share this
 * component; layout differs by CSS only. Every tab renders the single server
 * projection — there is no second data model and no client-side placement.
 */
type Tab = "atlas" | "triage";

export function MailApp() {
  const { view, error, dispatch } = useInboxView();
  const [tab, setTab] = useState<Tab>("atlas");

  if (error && !view) {
    return <div className="seer-error">Couldn’t load your inbox: {error}</div>;
  }
  if (!view) {
    return <div className="seer-loading">Reading your inbox…</div>;
  }

  const { coverage } = view;
  return (
    <div className="seer-app">
      <header className="seer-topbar">
        <nav role="tablist" aria-label="Views">
          <button
            role="tab"
            aria-selected={tab === "atlas"}
            aria-current={tab === "atlas" ? "page" : undefined}
            onClick={() => setTab("atlas")}
          >
            Atlas
          </button>
          <button
            role="tab"
            aria-selected={tab === "triage"}
            aria-current={tab === "triage" ? "page" : undefined}
            onClick={() => setTab("triage")}
          >
            Triage
          </button>
        </nav>
        <span className="seer-coverage">
          {coverage.read} of {coverage.providerTotal} read
          {coverage.pending > 0 ? ` · ${coverage.pending} still reading` : ""}
        </span>
      </header>

      <main>
        {tab === "atlas" ? (
          <>
            <Atlas view={view} />
            <WorthReading view={view} />
          </>
        ) : (
          <Triage view={view} dispatch={dispatch} />
        )}
      </main>
    </div>
  );
}
