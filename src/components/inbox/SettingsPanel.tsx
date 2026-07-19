"use client";

import {
  Check,
  ChevronLeft,
  Loader2,
  Mail,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  connectGoogleDesktop,
  connectGoogleMobile,
  connectMicrosoftDesktop,
  connectMicrosoftMobile,
  logout,
  logoutMobile,
} from "@/app/actions";

type AccountRow = {
  id: string;
  email: string;
  name: string;
  provider: "google" | "microsoft-entra-id";
  label: string;
  active?: boolean;
};

type AccountsPayload = {
  active: AccountRow | null;
  accounts: AccountRow[];
  available: { google: boolean; microsoft: boolean };
  sessionError: string | null;
};

export function SettingsPanel({
  mobile,
  onClose,
  onAccountsChanged,
}: {
  mobile?: boolean;
  onClose: () => void;
  onAccountsChanged?: () => void;
}) {
  const [data, setData] = useState<AccountsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load accounts");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function switchAccount(id: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "switch", id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await load();
      onAccountsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Switch failed");
    } finally {
      setBusy(null);
    }
  }

  async function removeAccount(id: string) {
    if (!confirm("Remove this account from Inbox Pilot on this device?")) {
      return;
    }
    setBusy(id);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await load();
      onAccountsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  }

  const googleAction = mobile ? connectGoogleMobile : connectGoogleDesktop;
  const microsoftAction = mobile
    ? connectMicrosoftMobile
    : connectMicrosoftDesktop;
  const signOutAction = mobile ? logoutMobile : logout;

  return (
    <div
      className={
        mobile
          ? "app-shell fixed inset-0 z-50 flex flex-col bg-[var(--bg)]"
          : "fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      }
    >
      {!mobile ? (
        <button
          type="button"
          className="flex-1"
          aria-label="Close settings"
          onClick={onClose}
        />
      ) : null}
      <div
        className={
          mobile
            ? "flex h-full flex-col"
            : "flex h-full w-full max-w-md flex-col bg-[var(--bg)] shadow-xl"
        }
      >
        <header className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-2">
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full"
            aria-label="Back"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <div className="flex items-center gap-2 text-[15px] font-medium">
            <Settings className="h-4 w-4" />
            Settings
          </div>
        </header>

        <div className="flex-1 overflow-auto px-4 py-4">
          {error ? (
            <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </p>
          ) : null}

          {data?.sessionError ? (
            <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              Session issue: reconnect an account below.
            </p>
          ) : null}

          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Active account
            </h2>
            {data?.active ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-semibold text-white">
                    {(data.active.name || data.active.email)[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {data.active.name || data.active.email}
                    </div>
                    <div className="truncate text-sm text-[var(--muted)]">
                      {data.active.email}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--primary)]">
                      {data.active.label}
                    </div>
                  </div>
                  <Check className="h-5 w-5 text-[var(--primary)]" />
                </div>
              </div>
            ) : !data ? (
              <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                No account connected yet. Add Gmail or Outlook below.
              </p>
            )}
          </section>

          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Add account
            </h2>
            <div className="space-y-2">
              {data?.available.google !== false ? (
                <form action={googleAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-left text-sm font-medium hover:bg-[var(--card)]"
                  >
                    <Plus className="h-4 w-4 text-[var(--primary)]" />
                    <Mail className="h-4 w-4" />
                    Connect Gmail
                  </button>
                </form>
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">
                  Gmail OAuth is not configured on this deployment.
                </p>
              )}
              {data?.available.microsoft !== false ? (
                <form action={microsoftAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-left text-sm font-medium hover:bg-[var(--card)]"
                  >
                    <Plus className="h-4 w-4 text-[var(--primary)]" />
                    <Mail className="h-4 w-4" />
                    Connect Outlook
                  </button>
                </form>
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-xs text-[var(--muted)]">
                  Outlook OAuth is not configured on this deployment.
                </p>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              Connecting signs you in with that provider and saves it here so
              you can switch mailboxes.
            </p>
          </section>

          {data && data.accounts.length > 0 ? (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                Saved accounts
              </h2>
              <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                {data.accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center gap-2 px-3 py-3"
                  >
                    <button
                      type="button"
                      disabled={busy === account.id || account.active}
                      onClick={() => switchAccount(account.id)}
                      className="min-w-0 flex-1 text-left disabled:opacity-60"
                    >
                      <div className="truncate text-sm font-medium">
                        {account.email}
                      </div>
                      <div className="text-xs text-[var(--muted)]">
                        {account.label}
                        {account.active ? " · Active" : ""}
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={busy === account.id}
                      onClick={() => removeAccount(account.id)}
                      className="rounded-full p-2 text-[var(--muted)] hover:bg-[var(--card)] hover:text-red-500"
                      aria-label="Remove account"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full rounded-xl border border-[var(--border)] py-3 text-sm font-medium text-red-600"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
