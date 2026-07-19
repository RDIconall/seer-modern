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
      <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-6 text-[var(--fg)]">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold">Inbox Pilot</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Your mail session expired. Sign in again to keep reading and
            deleting messages.
          </p>
          <form action={logout} className="mt-8">
            <button
              type="submit"
              className="w-full rounded-xl bg-[#1a73e8] py-3 text-sm font-medium text-white"
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
      <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-6 text-[var(--fg)]">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold">Inbox Pilot</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Read and triage Gmail here — with clear guidance on what to do with
            each message.
          </p>
          <div className="mt-8 flex flex-col gap-3">
            {google ? (
              <form action={loginGoogle}>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-[#1a73e8] py-3 text-sm font-medium text-white"
                >
                  Connect Gmail
                </button>
              </form>
            ) : null}
            {microsoft ? (
              <form action={loginMicrosoft}>
                <button
                  type="submit"
                  className="w-full rounded-xl border border-[var(--border)] py-3 text-sm font-medium"
                >
                  Connect Outlook
                </button>
              </form>
            ) : null}
          </div>
          {!google && !microsoft ? (
            <p className="mt-4 text-xs text-amber-400">
              Set OAuth credentials in .env.local — see .env.example
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <InboxApp />
      <form action={logout} className="fixed bottom-4 right-4 z-40 md:hidden">
        <button
          type="submit"
          className="rounded-full bg-[var(--card)] px-3 py-2 text-[10px] text-[var(--muted)] shadow"
        >
          Sign out
        </button>
      </form>
    </>
  );
}
