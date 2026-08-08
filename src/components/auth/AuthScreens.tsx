import {
  loginGoogle,
  loginGoogleMobile,
  loginMicrosoft,
  loginMicrosoftMobile,
  logout,
  logoutMobile,
} from "@/app/actions";
import Image from "next/image";
import Link from "next/link";

const google =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);
const microsoft =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

function SeerMark({ size = 80 }: { size?: number }) {
  return (
    <Image
      src="/seer-eye.png"
      alt="Seer"
      width={size}
      height={size}
      className="mx-auto"
      priority
    />
  );
}

export function SessionExpiredScreen({ mobile }: { mobile?: boolean }) {
  return (
    <div
      className={
        mobile
          ? "app-shell seer-atmosphere flex min-h-[100dvh] flex-col items-center justify-center px-6 text-[var(--fg)]"
          : "seer-atmosphere flex min-h-screen items-center justify-center px-6 text-[var(--fg)]"
      }
    >
      <div className="w-full max-w-sm text-center">
        <SeerMark size={64} />
        <h1 className="mt-4 text-2xl font-medium tracking-tight text-[var(--fg-strong)]">
          Session expired
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Sign in again to keep reading and sending mail.
        </p>
        <form action={mobile ? logoutMobile : logout} className="mt-8">
          <button
            type="submit"
            className="w-full rounded-md bg-[var(--brand)] py-3.5 text-sm font-medium text-white"
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
    <div className="app-shell seer-atmosphere flex min-h-[100dvh] flex-col justify-between px-6 pb-[max(1.5rem,var(--safe-bottom))] pt-16 text-[var(--fg)]">
      <div className="mx-auto w-full max-w-sm text-center">
        <SeerMark size={88} />
        <h1 className="seer-brand mt-5 text-4xl">Seer</h1>
        <p className="seer-tagline mt-1 text-lg">Fewer decisions.</p>
        <p className="mt-4 text-[15px] font-normal leading-relaxed text-[var(--muted)]">
          See what matters — swipe cards, compose on the go, triage when you
          need it.
        </p>
      </div>
      <div className="mx-auto w-full max-w-sm space-y-3">
        <ProviderButtons mobile />
        <p className="pt-1 text-center text-[11px] text-[var(--nav-muted)]">
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
      <div className="seer-atmosphere hidden w-[42%] flex-col justify-between p-12 md:flex">
        <div className="flex items-center gap-3">
          <Image src="/seer-eye.png" alt="" width={40} height={40} />
          <span className="seer-brand text-2xl">Seer</span>
        </div>
        <div>
          <h1 className="max-w-md text-4xl font-medium tracking-tight leading-tight text-[var(--fg-strong)]">
            See what matters. Clear the rest.
          </h1>
          <p className="seer-tagline mt-4 max-w-sm text-lg">Fewer decisions.</p>
          <p className="mt-4 max-w-sm text-[15px] font-normal leading-relaxed text-[var(--muted)]">
            Three-pane reading on a big screen. Cards and triage when you want
            to move fast. Mobile lives at /m.
          </p>
        </div>
        <p className="text-xs text-[var(--nav-muted)]">Gmail · Outlook</p>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-1 flex items-center gap-2 md:hidden">
            <Image src="/seer-eye.png" alt="" width={36} height={36} />
            <span className="seer-brand text-2xl">Seer</span>
          </div>
          <h2 className="text-xl font-medium text-[var(--fg-strong)]">Sign in</h2>
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
            className="w-full rounded-md bg-[var(--brand)] py-3.5 text-sm font-medium text-white shadow-sm transition hover:bg-[var(--brand-strong)]"
          >
            Continue with Google
          </button>
        </form>
      ) : null}
      {microsoft ? (
        <form action={microsoftAction}>
          <button
            type="submit"
            className="w-full rounded-md border border-[var(--border)] bg-white py-3.5 text-sm font-medium text-[var(--fg-strong)] transition hover:bg-[var(--card)]"
          >
            Continue with Microsoft
          </button>
        </form>
      ) : null}
      {!google && !microsoft ? (
        <p className="text-center text-xs text-[var(--accent)]">
          Set OAuth credentials in .env.local — see .env.example
        </p>
      ) : null}
    </>
  );
}
