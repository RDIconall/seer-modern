import { auth } from "@/auth";
import { loginGoogle, loginMicrosoft, logout } from "@/app/actions";
import { MailList } from "@/components/MailList";
import { NlpPanel } from "@/components/NlpPanel";

const google =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);
const microsoft =
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

export default async function Home() {
  const session = await auth();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <header className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-widest text-teal-400/90">
            Seer → modern stack
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Email-connected web app
          </h1>
          <p className="text-sm leading-relaxed text-zinc-400">
            The original{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">
              seer-master
            </code>{" "}
            project used Play 2.2, JavaMail/IMAP for Gmail, and Exchange Web
            Services with a password form. That stack is not realistically
            runnable today. This app is a small Next.js replacement that talks
            to mail the way providers expect now: OAuth 2.0, the Gmail API, and
            Microsoft Graph.
          </p>
        </header>

        {!google && !microsoft ? (
          <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-100/90">
            <p className="font-medium">Configure OAuth providers</p>
            <p className="mt-2 text-amber-100/70">
              Copy{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5">.env.example</code>{" "}
              to{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5">.env.local</code>{" "}
              and set{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5">AUTH_SECRET</code>{" "}
              plus at least one provider. Restart{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5">npm run dev</code>.
            </p>
          </section>
        ) : null}

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
          {session?.user ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-zinc-400">Signed in as</p>
                  <p className="font-medium text-zinc-100">
                    {session.user.email ?? session.user.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Provider: {session.provider ?? "unknown"}
                  </p>
                </div>
                <form action={logout}>
                  <button
                    type="submit"
                    className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800"
                  >
                    Sign out
                  </button>
                </form>
              </div>
              <div>
                <h2 className="mb-3 text-sm font-medium text-zinc-300">
                  Recent messages (read-only)
                </h2>
                <MailList snippets />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                Connect an account to verify Gmail API or Microsoft Graph from
                your machine.
              </p>
              <div className="flex flex-wrap gap-3">
                {google ? (
                  <form action={loginGoogle}>
                    <button
                      type="submit"
                      className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
                    >
                      Continue with Google
                    </button>
                  </form>
                ) : null}
                {microsoft ? (
                  <form action={loginMicrosoft}>
                    <button
                      type="submit"
                      className="rounded-lg bg-[#0078d4] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#106ebe]"
                    >
                      Continue with Microsoft
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
          <NlpPanel />
        </section>

        <footer className="text-xs text-zinc-600">
          Callback URLs:{" "}
          <code className="text-zinc-500">
            /api/auth/callback/google
          </code>
          ,{" "}
          <code className="text-zinc-500">
            /api/auth/callback/microsoft-entra-id
          </code>
        </footer>
      </main>
    </div>
  );
}
