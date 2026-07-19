import {
  loginGoogle,
  loginGoogleMobile,
  loginMicrosoft,
  loginMicrosoftMobile,
  logout,
  logoutMobile,
} from "@/app/actions";
import Link from "next/link";

const google =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);
const microsoft =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

export function SessionExpiredScreen({ mobile }: { mobile?: boolean }) {
  return (
    <div
      className={
        mobile
          ? "app-shell flex min-h-[100dvh] flex-col items-center justify-center bg-[var(--bg)] px-6 text-[var(--fg)]"
          : "flex min-h-screen items-center justify-center bg-[var(--bg)] px-6 text-[var(--fg)]"
      }
    >
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--primary)] text-2xl font-semibold text-white">
          IP
        </div>
        <h1 className="text-2xl font-normal">Session expired</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Sign in again to keep reading and sending mail.
        </p>
        <form action={mobile ? logoutMobile : logout} className="mt-8">
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

export function MobileLoginScreen() {
  return (
    <div className="app-shell flex min-h-[100dvh] flex-col justify-between bg-[var(--bg)] px-6 pb-[max(1.5rem,var(--safe-bottom))] pt-16 text-[var(--fg)]">
      <div className="mx-auto w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[1.25rem] bg-[var(--primary)] text-3xl font-semibold text-white shadow-sm">
          IP
        </div>
        <h1 className="text-3xl font-normal tracking-tight">Inbox Pilot</h1>
        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[var(--primary)]">
          Mobile
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--muted)]">
          Swipe to archive or delete, compose on the go, triage when you need
          it. Best as an installed home-screen app.
        </p>
      </div>
      <div className="mx-auto w-full max-w-sm space-y-3">
        <ProviderButtons mobile />
        <p className="pt-1 text-center text-[11px] text-[var(--muted)]">
          Add to Home Screen for the full app experience
        </p>
        <p className="text-center text-[11px]">
          <Link href="/" className="text-[var(--primary)] underline">
            Use desktop version
          </Link>
        </p>
      </div>
    </div>
  );
}

export function DesktopLoginScreen() {
  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="hidden w-[42%] flex-col justify-between bg-[var(--card)] p-12 md:flex">
        <div className="text-sm font-medium text-[var(--primary)]">
          Inbox Pilot
        </div>
        <div>
          <h1 className="max-w-md text-4xl font-normal tracking-tight leading-tight">
            Desktop mail with smart triage
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-[var(--muted)]">
            Three-pane reading on a big screen. The mobile PWA is a separate
            app at /m.
          </p>
        </div>
        <p className="text-xs text-[var(--muted)]">Gmail · Outlook</p>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-2 text-2xl font-normal md:hidden">Inbox Pilot</div>
          <h2 className="text-xl font-medium">Sign in</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Desktop workspace — folders, list, and reading pane.
          </p>
          <div className="mt-8 space-y-3">
            <ProviderButtons />
          </div>
          <p className="mt-8 text-center text-sm">
            <Link href="/m" className="text-[var(--primary)] underline">
              Open mobile app
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function ProviderButtons({ mobile }: { mobile?: boolean }) {
  const googleAction = mobile ? loginGoogleMobile : loginGoogle;
  const microsoftAction = mobile ? loginMicrosoftMobile : loginMicrosoft;
  return (
    <>
      {google ? (
        <form action={googleAction}>
          <button
            type="submit"
            className="w-full rounded-full bg-[var(--primary)] py-3.5 text-sm font-medium text-white"
          >
            Continue with Google
          </button>
        </form>
      ) : null}
      {microsoft ? (
        <form action={microsoftAction}>
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
    </>
  );
}
