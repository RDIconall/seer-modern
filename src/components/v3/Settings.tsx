"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  connectGoogleDesktop,
  connectGoogleMobile,
  connectMicrosoftDesktop,
  connectMicrosoftMobile,
  logout,
  reconnectAccount,
} from "@/app/actions";
import { fetchFresh } from "@/lib/v3/net/fetch";
import {
  ACCOUNT_CHANGED_EVENT,
  clearMailboxCaches,
} from "./useMailbox";

type Account = {
  id: string;
  provider: "google" | "microsoft";
  email: string;
  name: string;
  label: string;
  active: boolean;
  status: "active" | "reconnect_required";
};

type AccountData = {
  active: Account | null;
  accounts: Account[];
  available: { google: boolean; microsoft: boolean };
  sessionError: string | null;
};

const PROVIDER_NAME: Record<Account["provider"], string> = {
  google: "Google",
  microsoft: "Microsoft",
};

function initialFor(account: Account): string {
  const source = account.name.trim() || account.email.trim();
  return (source.slice(0, 1) || "?").toUpperCase();
}

export function Settings({ mobile = false }: { mobile?: boolean }) {
  const [data, setData] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetchFresh("/api/v3/accounts");
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
      const json = (await response.json()) as {
        error?: string;
        requiresSignOut?: boolean;
      };
      if (!response.ok) throw new Error(json.error ?? `${action} failed`);
      if (action === "remove" && json.requiresSignOut) {
        await logout();
        return;
      }
      if (action === "switch" || action === "remove") {
        clearMailboxCaches();
        window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
      }
      await load();
    } catch (cause) {
      if (cause && typeof cause === "object" && "digest" in cause) throw cause;
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

  if (!data && !error) {
    return (
      <section className="mail-settings" aria-label="Settings">
        <p className="mail-settings-loading">Loading settings…</p>
      </section>
    );
  }

  return (
    <section className="mail-settings" aria-label="Settings">
      <header className="mail-settings-header">
        <h1>Settings</h1>
        <p>Manage the mailboxes connected to your Seer account.</p>
      </header>

      {error && (
        <p className="mail-settings-alert" role="alert">
          <AlertTriangle className="mail-settings-alert-icon" aria-hidden="true" />
          {error}
        </p>
      )}
      {data?.sessionError && (
        <p className="mail-settings-alert" role="alert">
          <AlertTriangle className="mail-settings-alert-icon" aria-hidden="true" />
          Your sign-in needs attention. Reconnect the current account to continue.
        </p>
      )}

      <section className="mail-settings-section" aria-labelledby="current-account-heading">
        <h2 className="mail-settings-heading" id="current-account-heading">
          Current account
        </h2>
        {data?.active ? (
          <div className="mail-settings-card">
            <span className="mail-settings-avatar" aria-hidden="true">
              {initialFor(data.active)}
            </span>
            <span className="mail-settings-identity">
              <strong className="mail-settings-email">{data.active.email}</strong>
              <span className="mail-settings-label">{data.active.label}</span>
            </span>
            <Check className="mail-settings-check" aria-hidden="true" />
          </div>
        ) : (
          <p className="mail-settings-empty">No account is currently selected.</p>
        )}
      </section>

      <section className="mail-settings-section" aria-labelledby="accounts-heading">
        <h2 className="mail-settings-heading" id="accounts-heading">
          Connected accounts
        </h2>
        {data?.accounts.length ? (
          <ul className="mail-settings-list">
            {data.accounts.map((account) => (
              <li
                className="mail-settings-account"
                key={account.id}
                data-active={account.active ? "true" : "false"}
              >
                <span className="mail-settings-avatar" aria-hidden="true">
                  {initialFor(account)}
                </span>
                <span className="mail-settings-identity">
                  <strong className="mail-settings-email">{account.email}</strong>
                  <span className="mail-settings-label">
                    {PROVIDER_NAME[account.provider]} · {account.label}
                  </span>
                  {account.status === "reconnect_required" && (
                    <strong className="mail-settings-badge" role="status">
                      Needs reconnect
                    </strong>
                  )}
                </span>
                <span className="mail-settings-actions">
                  <button
                    className="mail-settings-button"
                    type="button"
                    disabled={account.active || busy === account.id}
                    onClick={() => void accountAction(account.id, "switch")}
                  >
                    {account.active ? "Current" : "Switch"}
                    <span className="mail-settings-sr">
                      {account.active ? " account" : ` to ${account.email}`}
                    </span>
                  </button>
                  <button
                    className="mail-settings-button"
                    type="button"
                    disabled={busy === account.id}
                    onClick={() => void reconnect(account.id)}
                  >
                    <RefreshCw className="mail-settings-button-icon" aria-hidden="true" />
                    Reconnect
                  </button>
                  <button
                    className="mail-settings-button mail-settings-danger"
                    type="button"
                    disabled={busy === account.id}
                    onClick={() => {
                      if (window.confirm(`Remove ${account.email} from Seer?`)) {
                        void accountAction(account.id, "remove");
                      }
                    }}
                  >
                    <Trash2 className="mail-settings-button-icon" aria-hidden="true" />
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mail-settings-empty">No connected accounts.</p>
        )}
      </section>

      <section className="mail-settings-section" aria-labelledby="add-account-heading">
        <h2 className="mail-settings-heading" id="add-account-heading">
          Add account
        </h2>
        <div className="mail-settings-add">
          {data?.available.google && (
            <form action={mobile ? connectGoogleMobile : connectGoogleDesktop}>
              <button className="mail-settings-connect" type="submit">
                <Plus className="mail-settings-button-icon" aria-hidden="true" />
                <Mail className="mail-settings-button-icon" aria-hidden="true" />
                Add Google account
              </button>
            </form>
          )}
          {data?.available.microsoft && (
            <form action={mobile ? connectMicrosoftMobile : connectMicrosoftDesktop}>
              <button className="mail-settings-connect" type="submit">
                <Plus className="mail-settings-button-icon" aria-hidden="true" />
                <Mail className="mail-settings-button-icon" aria-hidden="true" />
                Add Microsoft account
              </button>
            </form>
          )}
        </div>
      </section>

      <form className="mail-settings-signout" action={logout}>
        <button className="mail-settings-button" type="submit">
          <LogOut className="mail-settings-button-icon" aria-hidden="true" />
          Sign out
        </button>
      </form>
    </section>
  );
}
