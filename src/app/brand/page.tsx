import Image from "next/image";
import Link from "next/link";
import { seerStudio } from "@/lib/brand/seer-2026";

const c = seerStudio.colors;

const palette = [
  { name: "Ink", hex: c.ink, role: "Primary type" },
  { name: "Ink soft", hex: c.inkSoft, role: "Body" },
  { name: "Mute", hex: c.mute, role: "Meta floor" },
  { name: "Paper", hex: c.paper, role: "Reading ground" },
  { name: "Paper deep", hex: c.paperDeep, role: "Quiet chrome" },
  { name: "Brand", hex: c.brand, role: "Identity / CTAs" },
  { name: "Brand deep", hex: c.brandDeep, role: "Pressed" },
  { name: "Signal", hex: c.signal, role: "Needs you today" },
  { name: "Action", hex: c.action, role: "Links / send" },
  { name: "Violet", hex: c.violet, role: "Chip only" },
  { name: "Clear", hex: c.clear, role: "Chip only" },
  { name: "Lime", hex: c.lime, role: "Chip only" },
] as const;

export default function BrandPage() {
  return (
    <main className="seer-2026-atmosphere seer-2026-wash">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-3">
          <Image
            src="/seer-mark.png"
            alt=""
            width={36}
            height={36}
            className="seer-2026-mark-in"
            priority
          />
          <span
            className="text-[1.35rem] font-medium tracking-[-0.035em] text-[var(--s-ink)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Seer
          </span>
        </div>
        <Link
          href="/"
          className="text-sm font-medium text-[var(--s-mute)] transition hover:text-[var(--s-ink)]"
        >
          Back to app
        </Link>
      </header>

      {/* Hero — brand idea first */}
      <section className="mx-auto flex min-h-[78vh] w-full max-w-6xl flex-col justify-center px-6 pb-20 pt-8 md:px-10">
        <p className="seer-2026-kicker seer-2026-rise">
          Studio direction · Collins × Wolff Olins lens
        </p>
        <div className="mt-8 flex flex-col items-start gap-10 md:flex-row md:items-center md:gap-16">
          <Image
            src="/seer-mark.png"
            alt="Seer circle mark"
            width={160}
            height={160}
            className="seer-2026-mark-in shrink-0"
            priority
          />
          <div className="min-w-0">
            <h1 className="seer-2026-wordmark seer-2026-rise-delay">Seer</h1>
            <p className="seer-2026-idea seer-2026-rise-delay mt-4">
              {seerStudio.idea}
            </p>
            <p className="seer-2026-lede seer-2026-rise-delay-2 mt-5">
              For busy professionals with decision overload. The product
              triages email so they decide less. The brand should feel like
              that relief — quiet authority, scarce urgency, type built to be
              read under stress.
            </p>
            <div className="seer-2026-rise-delay-2 mt-8 flex flex-wrap gap-3">
              <a href="#idea" className="seer-2026-cta">
                The idea
              </a>
              <a href="#system" className="seer-2026-cta-ghost">
                Type & color
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Idea + principles */}
      <section
        id="idea"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Positioning</p>
        <h2 className="seer-2026-section-title mt-3">
          What Collins or Wolff Olins would lock first
        </h2>
        <p className="seer-2026-body mt-4">
          Not a prettier inbox. A decision diet. Seer’s audience doesn’t need
          more chrome — they need fewer choices and a clear next move. That
          becomes the brand idea, then type and color serve it.
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {seerStudio.principles.map((p) => (
            <div
              key={p.title}
              className="rounded-lg border border-[var(--s-hairline)] bg-white px-6 py-5"
            >
              <p
                className="text-lg font-medium tracking-[-0.02em] text-[var(--s-ink)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {p.title}
              </p>
              <p className="mt-2 text-[15px] leading-relaxed text-[var(--s-ink-soft)]">
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Type */}
      <section
        id="system"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Typography · Klim</p>
        <h2 className="seer-2026-section-title mt-3">Type that lowers pulse</h2>
        <p className="seer-2026-body mt-4">
          Agencies at this level pick faces that disappear into the job.{" "}
          <strong className="font-semibold text-[var(--s-ink)]">
            Untitled Sans
          </strong>{" "}
          for lists and long reading.{" "}
          <strong className="font-semibold text-[var(--s-ink)]">Söhne</strong>{" "}
          for the wordmark — sentence case, tight tracking, no 2014 uppercase
          lockup in product.
        </p>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-[var(--s-hairline)] bg-white p-6 md:p-8">
            <p className="seer-2026-caption">Display · Söhne</p>
            <p
              className="mt-5 text-[3.25rem] font-medium leading-none tracking-[-0.04em] text-[var(--s-ink)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Seer
            </p>
            <p className="seer-2026-caption mt-6">500 · −0.04em · wordmark</p>
          </div>
          <div className="rounded-lg border border-[var(--s-hairline)] bg-white p-6 md:p-8">
            <p className="seer-2026-caption">Reading · Untitled Sans</p>
            <p className="mt-5 max-w-[28rem] text-[1.125rem] leading-[1.65] text-[var(--s-ink-soft)]">
              Your inbox should feel like clear water — subjects land, bodies
              breathe, the next action is obvious. Seventeen pixels. Measure
              capped. No decoration between you and the ask.
            </p>
            <p className="seer-2026-caption mt-6">400 · 17px / 1.65 · max 58ch</p>
          </div>
        </div>
      </section>

      {/* Color */}
      <section className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10">
        <p className="seer-2026-kicker">Color</p>
        <h2 className="seer-2026-section-title mt-3">
          Quiet field. Scarce signal.
        </h2>
        <p className="seer-2026-body mt-4">
          Wolff Olins would own one cultural color; Collins would refuse the
          rest. Brand teal for identity. Logo orange only when something truly
          needs you today. Spectrum from the circle stays on the mark — chips
          for triage tags, never full-bleed washes.
        </p>

        <div className="mt-6">
          <span className="seer-signal-chip">Needs you · Signal only</span>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {palette.map((swatch) => (
            <div
              key={swatch.name}
              className="seer-2026-swatch overflow-hidden rounded-lg border border-[var(--s-hairline)] bg-white"
            >
              <div
                className="seer-swatch h-20 w-full"
                style={{ ["--swatch" as string]: swatch.hex }}
                aria-hidden
              />
              <div className="px-3 py-2.5">
                <p className="text-sm font-semibold text-[var(--s-ink)]">
                  {swatch.name}
                </p>
                <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-[var(--s-mute)]">
                  {swatch.hex}
                </p>
                <p className="mt-1 text-[12px] leading-snug text-[var(--s-ink-soft)]">
                  {swatch.role}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Product proof */}
      <section
        id="product"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">In product</p>
        <h2 className="seer-2026-section-title mt-3">How the idea shows up</h2>
        <p className="seer-2026-body mt-4">
          Login is brand-forward and calm. The inbox uses orange only on true
          urgency. Everything else is ink on paper — so the professional can
          decide once and move.
        </p>

        <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.15fr]">
          <LoginPreview />
          <MailPreview />
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-10 md:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Image src="/seer-mark.png" alt="" width={28} height={28} />
            <p className="text-sm text-[var(--s-mute)]">
              {seerStudio.idea} · Circle mark · Klim type · Scarce signal
            </p>
          </div>
          <Link
            href="/"
            className="text-sm font-semibold text-[var(--s-brand)] hover:text-[var(--s-brand-deep)]"
          >
            Open Seer
          </Link>
        </div>
      </footer>
    </main>
  );
}

function LoginPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--s-hairline)] bg-white shadow-[0_20px_50px_-36px_rgba(11,13,16,0.4)]">
      <div className="seer-2026-atmosphere flex flex-col items-center px-8 py-12 text-center">
        <Image src="/seer-mark.png" alt="" width={72} height={72} />
        <p
          className="mt-5 text-[2.5rem] font-medium tracking-[-0.04em] text-[var(--s-ink)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Seer
        </p>
        <p className="mt-2 text-[1.05rem] font-medium tracking-[-0.02em] text-[var(--s-ink)]">
          Fewer decisions.
        </p>
        <p className="mt-3 max-w-[18rem] text-[15px] leading-relaxed text-[var(--s-ink-soft)]">
          Fly through email with your copilot — triage what needs you, clear
          the rest.
        </p>
        <button type="button" className="seer-2026-cta mt-8 w-full max-w-[18rem]">
          Continue with Google
        </button>
        <button
          type="button"
          className="seer-2026-cta-ghost mt-3 w-full max-w-[18rem]"
        >
          Continue with Microsoft
        </button>
      </div>
    </div>
  );
}

function MailPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--s-hairline)] bg-white shadow-[0_20px_50px_-36px_rgba(11,13,16,0.4)]">
      <div className="seer-chrome-bar flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Image src="/seer-mark.png" alt="" width={22} height={22} />
          <span
            className="text-[1.05rem] font-medium tracking-[-0.025em]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Seer
          </span>
        </div>
        <span className="text-xs font-medium text-white/85">Inbox</span>
      </div>

      <div className="divide-y divide-[var(--s-hairline)]">
        <MailRow
          urgent
          from="Alex Rivera"
          subject="Q3 hiring plan — need your eyes"
          preview="Can you scan the brief before Thursday’s sync?"
          time="2:14 PM"
        />
        <MailRow
          from="Calendar"
          subject="Reminder: design critique"
          preview="Starts in 45 minutes · Room B"
          time="1:02 PM"
        />
        <MailRow
          from="Stripe"
          subject="Your payout of $2,480.00 is on the way"
          preview="Funds typically arrive in 1–2 business days."
          time="11:40 AM"
        />
      </div>

      <div className="border-t border-[var(--s-hairline)] bg-[var(--s-paper-deep)]/50 px-5 py-5">
        <div className="flex items-center gap-2">
          <span className="seer-signal-chip">Act today</span>
          <p className="text-xs text-[var(--s-mute)]">Signal used once</p>
        </div>
        <h3
          className="mt-3 text-[1.2rem] font-semibold tracking-[-0.02em] text-[var(--s-ink)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Q3 hiring plan — need your eyes
        </h3>
        <p className="mt-1 text-sm text-[var(--s-mute)]">
          Alex Rivera · Today 2:14 PM
        </p>
        <p className="mt-4 max-w-[58ch] text-[15px] leading-[1.65] text-[var(--s-ink-soft)]">
          Can you scan the attached brief before Thursday’s sync? The role mix
          shifted — two IC seats, one lead — and I want your read on leveling
          before we post.
        </p>
      </div>
    </div>
  );
}

function MailRow({
  from,
  subject,
  preview,
  time,
  urgent,
}: {
  from: string;
  subject: string;
  preview: string;
  time: string;
  urgent?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 px-4 py-3.5 ${
        urgent ? "border-l-4 border-[var(--s-signal)] bg-[var(--s-paper)]" : ""
      }`}
    >
      <span
        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
          urgent ? "bg-[var(--s-signal)]" : "bg-[var(--s-action)]"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-[14px] font-semibold text-[var(--s-ink)]">
            {from}
          </p>
          <p className="shrink-0 text-[12px] text-[var(--s-mute)]">{time}</p>
        </div>
        <p className="mt-0.5 truncate text-[14px] font-medium text-[var(--s-ink)]">
          {subject}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-[var(--s-mute)]">
          {preview}
        </p>
      </div>
    </div>
  );
}
