"use client";

import { useCallback, useEffect, useState } from "react";
import {
  connectGoogleDesktop,
  connectMicrosoftDesktop,
  logout,
  reconnectAccount,
} from "@/app/actions";

type Account = {
  id: string;
  provider: "google" | "microsoft";
  email: string;
  name: string;
  label: string;
  active: boolean;
};

type AccountData = {
  active: Account | null;
  accounts: Account[];
  available: { google: boolean; microsoft: boolean };
  sessionError: string | null;
};

export function Settings() {
  const [data, setData] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/v3/accounts", { cache: "no-store" });
    const json = (await response.json()) as AccountData & { error?: string };
    if (!response.ok) throw new Error(json.error ?? "Unable to load accounts");
    setData(json);
  }, []);

  useEffect(() => {
    void load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Unable to load accounts");
    });
  }, [load]);

  async function accountAction(id: string, action: "switch" | "remove") {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/v3/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          action,
          ...(action === "remove" ? { confirmed: true } : {}),
        }),
      });
      const json = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(json.error ?? `${action} failed`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${action} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function reconnect(id: string) {
    setBusy(id);
    setError(null);
    try {
      await reconnectAccount(id, window.location.pathname === "/m");
    } catch (cause) {
      // Next.js uses a redirect signal for the successful OAuth handoff.
      if (cause && typeof cause === "object" && "digest" in cause) throw cause;
      setError(cause instanceof Error ? cause.message : "Reconnect failed");
      setBusy(null);
    }
  }

  function connect(provider: "google" | "microsoft") {
    const callback = `${window.location.pathname}?settings=1`;
    window.location.assign(
      `/api/auth/signin/${provider === "google" ? "google" : "microsoft-entra-id"}?callbackUrl=${encodeURIComponent(callback)}`,
    );
  }

  if (!data && !error) {
    return <section className="mail-settings" aria-label="Settings">Loading settings…</section>;
  }

  return (
    <section className="mail-settings" aria-label="Settings">
      <h1>Settings</h1>
      <p>Manage the mailboxes connected to your Seer account.</p>

      {error && <p role="alert">{error}</p>}
      {data?.sessionError && (
        <p role="alert">
          Your sign-in needs attention. Reconnect the current account to continue.
        </p>
      )}

      <section aria-labelledby="current-account-heading">
        <h2 id="current-account-heading">Current account</h2>
        {data?.active ? (
          <div>
            <strong>{data.active.email}</strong>
            <span>{data.active.label}</span>
          </div>
        ) : (
          <p>No account is currently selected.</p>
        )}
      </section>

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Connected accounts</h2>
        {data?.accounts.length ? (
          <ul>
            {data.accounts.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  disabled={account.active || busy === account.id}
                  onClick={() => void accountAction(account.id, "switch")}
                >
                  {account.active ? "Current" : "Switch"} {account.email}
                </button>
                <span>{account.label}</span>
                <button
                  type="button"
                  disabled={busy === account.id}
                  onClick={() => void reconnect(account.id)}
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  disabled={busy === account.id}
                  onClick={() => {
                    if (window.confirm(`Remove ${account.email} from Seer?`)) {
                      void accountAction(account.id, "remove");
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No connected accounts.</p>
        )}
      </section>

      <section aria-labelledby="add-account-heading">
        <h2 id="add-account-heading">Add account</h2>
        <div>
          {data?.available.google && (
            <button type="button" onClick={() => connect("google")}>
              Add Google account
            </button>
          )}
          {data?.available.microsoft && (
            <button type="button" onClick={() => connect("microsoft")}>
              Add Microsoft account
            </button>
          )}
          {/* Keep these server actions reachable for environments that disable
              direct provider sign-in links during form POST hardening. */}
          <form action={connectGoogleDesktop} hidden />
          <form action={connectMicrosoftDesktop} hidden />
        </div>
      </section>

      <form action={logout}>
        <button type="submit">Sign out</button>
      </form>
    </section>
  );
}
