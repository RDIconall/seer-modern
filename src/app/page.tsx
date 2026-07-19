import { auth } from "@/auth";
import { loginGoogle, loginMicrosoft, logout } from "@/app/actions";
import { InboxApp } from "@/components/inbox/InboxApp";

const google =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);
const microsoft =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

export default async function Home() {
  const session = await auth();

  if (session?.user && session.error) {
    return (
      <div className="app-shell flex min-h-[100dvh] flex-col items-center justify-center bg-[var(--bg)] px-6 text-[var(--fg)]">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--primary)] text-2xl font-semibold text-white">
            IP
          </div>
          <h1 className="text-2xl font-normal">Session expired</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Sign in again to keep reading and sending mail.
          </p>
          <form action={logout} className="mt-8">
            <button
              type="submit"
              className="w-full rounded-full bg-[var(--primary)] py-3.5 text-sm font-medium text-white"
            >
              Sign out and reconnect
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="app-shell flex min-h-[100dvh] flex-col justify-between bg-[var(--bg)] px-6 pb-[max(1.5rem,var(--safe-bottom))] pt-16 text-[var(--fg)]">
        <div className="mx-auto w-full max-w-sm text-center">
          <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[1.25rem] bg-[var(--primary)] text-3xl font-semibold text-white shadow-sm">
            IP
          </div>
          <h1 className="text-3xl font-normal tracking-tight">Inbox Pilot</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--muted)]">
            Installable mail for Gmail and Outlook — swipe to archive or
            delete, compose on the go, triage when you need it.
          </p>
        </div>
        <div className="mx-auto w-full max-w-sm space-y-3">
          {google ? (
            <form action={loginGoogle}>
              <button
                type="submit"
                className="w-full rounded-full bg-[var(--primary)] py-3.5 text-sm font-medium text-white"
              >
                Continue with Google
              </button>
            </form>
          ) : null}
          {microsoft ? (
            <form action={loginMicrosoft}>
              <button
                type="submit"
                className="w-full rounded-full border border-[var(--border)] bg-[var(--card)] py-3.5 text-sm font-medium"
              >
                Continue with Microsoft
              </button>
            </form>
          ) : null}
          {!google && !microsoft ? (
            <p className="text-center text-xs text-amber-600">
              Set OAuth credentials in .env.local — see .env.example
            </p>
          ) : null}
          <p className="pt-2 text-center text-[11px] text-[var(--muted)]">
            On your phone: open in Safari/Chrome → Add to Home Screen
          </p>
        </div>
      </div>
    );
  }

  return <InboxApp />;
}
