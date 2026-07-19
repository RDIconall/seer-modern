"use client";

import {
  BookUser,
  Check,
  ChevronLeft,
  Download,
  Link2,
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

type ProfilePayload = {
  profile: {
    text: string;
    updatedAt: string;
    source: "paste" | "google-doc";
    sourceUrl?: string;
  } | null;
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
  const [exportBusy, setExportBusy] = useState(false);

  const [profileText, setProfileText] = useState("");
  const [profileMeta, setProfileMeta] =
    useState<ProfilePayload["profile"]>(null);
  const [docUrl, setDocUrl] = useState("");
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const [profileNote, setProfileNote] = useState<string | null>(null);

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

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/profile", { cache: "no-store" });
      const json = (await res.json()) as ProfilePayload;
      if (res.ok) {
        setProfileMeta(json.profile);
        setProfileText(json.profile?.text ?? "");
        if (json.profile?.sourceUrl) setDocUrl(json.profile.sourceUrl);
      }
    } catch {
      /* profile is optional — settings still work */
    }
  }, []);

  useEffect(() => {
    load();
    loadProfile();
  }, [load, loadProfile]);

  async function saveProfile(payload: {
    text?: string;
    docUrl?: string;
    clear?: boolean;
  }) {
    setProfileBusy(payload.clear ? "clear" : payload.docUrl ? "doc" : "text");
    setProfileNote(null);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setProfileMeta(json.profile);
      setProfileText(json.profile?.text ?? "");
      setProfileNote(
        json.profile
          ? "Saved. Every email gets a fresh look with this in mind on the next refresh."
          : "Cleared.",
      );
      onAccountsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Profile save failed");
    } finally {
      setProfileBusy(null);
    }
  }

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
    if (!confirm("Remove this account from Seer on this device?")) {
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

  async function downloadClassifierSamples() {
    setExportBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/classifier/samples", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Export failed");
      const blob = new Blob([JSON.stringify(json, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seer-classifier-samples-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExportBusy(false);
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
            <p className="mb-3 rounded-lg bg-[#d63b2f]/10 px-3 py-2 text-sm text-[#d63b2f]">
              {error}
            </p>
          ) : null}

          {data?.sessionError ? (
            <p className="mb-3 rounded-lg bg-[#ff8f2d]/10 px-3 py-2 text-sm text-[#c96a10]">
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

          <section className="mb-6">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <BookUser className="h-3.5 w-3.5" />
              About you — AI memory
            </h2>
            <textarea
              value={profileText}
              onChange={(e) => setProfileText(e.target.value)}
              rows={6}
              maxLength={8000}
              placeholder={
                "Who you are, in your own words: role, companies, family, current priorities, VIP people, what counts as urgent for you…"
              }
              className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-[var(--primary)]"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={profileBusy !== null || !profileText.trim()}
                onClick={() => saveProfile({ text: profileText })}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {profileBusy === "text" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save memory
              </button>
              {profileMeta ? (
                <button
                  type="button"
                  disabled={profileBusy !== null}
                  onClick={() => saveProfile({ clear: true })}
                  className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[#d63b2f] disabled:opacity-50"
                >
                  {profileBusy === "clear" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Clear"
                  )}
                </button>
              ) : null}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="url"
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                placeholder="…or paste a Google Doc link about you"
                className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
              />
              <button
                type="button"
                disabled={profileBusy !== null || !docUrl.trim()}
                onClick={() => saveProfile({ docUrl })}
                className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                {profileBusy === "doc" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4 text-[var(--primary)]" />
                )}
                Import
              </button>
            </div>

            {profileNote ? (
              <p className="mt-2 text-[11px] font-medium text-[var(--primary)]">
                {profileNote}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              {profileMeta
                ? `Saved ${new Date(profileMeta.updatedAt).toLocaleDateString()}${
                    profileMeta.source === "google-doc"
                      ? " · imported from Google Docs (re-import after editing the doc)"
                      : ""
                  }. `
                : ""}
              This rides along on every Gemini triage call and reply draft so
              decisions are made as <em>you</em> — who matters, what&apos;s
              urgent, how you sound. Stored privately on the server; saving
              re-reviews your inbox once with the new context.
            </p>
          </section>

          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Classifier tuning
            </h2>
            <button
              type="button"
              disabled={exportBusy || !data?.active}
              onClick={downloadClassifierSamples}
              className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-left text-sm font-medium hover:bg-[var(--card)] disabled:opacity-50"
            >
              {exportBusy ? (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
              ) : (
                <Download className="h-4 w-4 text-[var(--primary)]" />
              )}
              Download classifier samples
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              Exports subject + snippet + predicted rule for ~60 inbox messages
              (no HTML bodies). Share that file so we can tune rules against your
              real mail without training an ML model on Gmail.
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
                      className="rounded-full p-2 text-[var(--muted)] hover:bg-[var(--card)] hover:text-[#d63b2f]"
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
              className="w-full rounded-xl border border-[var(--border)] py-3 text-sm font-medium text-[#d63b2f]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
