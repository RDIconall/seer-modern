import Image from "next/image";
import Link from "next/link";
import { seerStudio } from "@/lib/brand/seer-2026";

const c = seerStudio.colors;

const corePalette = [
  { name: "Ink", hex: c.ink, role: "Type + pupil" },
  { name: "Paper", hex: c.paper, role: "Reading ground" },
  { name: "Field", hex: c.field, role: "Quiet chrome" },
  { name: "Brand", hex: c.brand, role: "Identity / iris" },
  { name: "Brand soft", hex: c.brandSoft, role: "Selected / mist" },
  { name: "Signal", hex: c.signal, role: "Needs you today" },
  { name: "Action", hex: c.action, role: "Links / send" },
  { name: "Mute", hex: c.mute, role: "Meta text floor" },
] as const;

export default function BrandPage() {
  const heroMark = seerStudio.logo.recommended;

  return (
    <main className="seer-2026-atmosphere seer-2026-wash">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-3">
          <Image
            src={heroMark}
            alt=""
            width={36}
            height={36}
            className="seer-2026-mark-in"
            priority
            unoptimized
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

      <section className="mx-auto flex min-h-[72vh] w-full max-w-6xl flex-col justify-center px-6 pb-16 pt-8 md:px-10">
        <p className="seer-2026-kicker seer-2026-rise">
          Studio direction · colors & mark
        </p>
        <div className="mt-8 flex flex-col items-start gap-10 md:flex-row md:items-center md:gap-16">
          <Image
            src={heroMark}
            alt="Seer dual-tone eye mark"
            width={168}
            height={168}
            className="seer-2026-mark-in shrink-0"
            priority
            unoptimized
          />
          <div className="min-w-0">
            <h1 className="seer-2026-wordmark seer-2026-rise-delay">Seer</h1>
            <p className="seer-2026-idea seer-2026-rise-delay mt-4">
              {seerStudio.idea}
            </p>
            <p className="seer-2026-lede seer-2026-rise-delay-2 mt-3 text-[var(--s-mute)]">
              {seerStudio.metaphor}
            </p>
            <p className="seer-2026-lede seer-2026-rise-delay-2 mt-5">
              Collins would cut the rainbow. Wolff Olins would own one cultural
              color. Same eye geometry — gray ring, teal iris, ink pupil —
              so “seeing what matters” lands in the center, not in nine hues.
            </p>
            <div className="seer-2026-rise-delay-2 mt-8 flex flex-wrap gap-3">
              <a href="#colors" className="seer-2026-cta">
                The colors
              </a>
              <a href="#mark" className="seer-2026-cta-ghost">
                Eye options
              </a>
            </div>
          </div>
        </div>
      </section>

      <section
        id="colors"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Palette</p>
        <h2 className="seer-2026-section-title mt-3">Eight tokens. That’s the brand.</h2>
        <p className="seer-2026-body mt-4">
          Drop purple, lime, cyan as brand colors. Keep teal as the one owned
          hue (from the old middle ring). Orange is signal only — scarce on
          purpose. Blue is functional, not identity.
        </p>

        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {corePalette.map((swatch) => (
            <div
              key={swatch.name}
              className="seer-2026-swatch overflow-hidden rounded-lg border border-[var(--s-hairline)] bg-white"
            >
              <div
                className="seer-swatch h-24 w-full"
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
                <p className="mt-1 text-[12px] text-[var(--s-ink-soft)]">
                  {swatch.role}
                </p>
              </div>
            </div>
          ))}
        </div>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {seerStudio.principles.map((p) => (
            <li
              key={p.title}
              className="rounded-lg border border-[var(--s-hairline)] bg-white px-5 py-4"
            >
              <p
                className="font-medium tracking-[-0.02em] text-[var(--s-ink)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {p.title}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--s-ink-soft)]">
                {p.body}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        id="mark"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Mark</p>
        <h2 className="seer-2026-section-title mt-3">
          Same eye. Fewer colors.
        </h2>
        <p className="seer-2026-body mt-4">
          Recommended: <strong className="text-[var(--s-ink)]">Dual</strong> —
          cool gray outer, brand teal iris, ink pupil. Keeps the “seeing”
          metaphor without the 2014 spectrum. Focus is the alternate if you
          want signal orange literally in the pupil.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {seerStudio.logo.options.map((opt) => (
            <div
              key={opt.id}
              data-rec={opt.id === "dual" ? "true" : undefined}
              className="seer-mark-card rounded-lg border border-[var(--s-hairline)] bg-white p-5"
            >
              <div className="flex h-36 items-center justify-center rounded-md bg-[var(--s-paper-deep)]">
                <Image
                  src={opt.src}
                  alt={opt.title}
                  width={112}
                  height={112}
                  unoptimized
                />
              </div>
              <p
                className="mt-4 text-[15px] font-medium tracking-[-0.02em] text-[var(--s-ink)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {opt.title}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--s-ink-soft)]">
                {opt.note}
              </p>
            </div>
          ))}

          <div className="seer-mark-card rounded-lg border border-[var(--s-hairline)] bg-white p-5 opacity-70">
            <div className="flex h-36 items-center justify-center rounded-md bg-[var(--s-ink)]">
              <p className="px-4 text-center text-xs text-white/70">
                Legacy spectrum archived — nine hues, heritage only
              </p>
            </div>
            <p
              className="mt-4 text-[15px] font-medium tracking-[-0.02em] text-[var(--s-ink)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Legacy · spectrum
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--s-ink-soft)]">
              Replaced in-app by Dual. Original PNG kept out of chrome.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10">
        <p className="seer-2026-kicker">In product</p>
        <h2 className="seer-2026-section-title mt-3">Quiet chrome, scarce orange</h2>
        <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.15fr]">
          <LoginPreview mark={heroMark} />
          <MailPreview mark={heroMark} />
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-10 md:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Image src={heroMark} alt="" width={28} height={28} unoptimized />
            <p className="text-sm text-[var(--s-mute)]">
              {seerStudio.idea} · Dual eye · 8 color tokens
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

function LoginPreview({ mark }: { mark: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--s-hairline)] bg-white shadow-[0_20px_50px_-36px_rgba(11,13,16,0.4)]">
      <div className="seer-2026-atmosphere flex flex-col items-center px-8 py-12 text-center">
        <Image src={mark} alt="" width={72} height={72} unoptimized />
        <p
          className="mt-5 text-[2.5rem] font-medium tracking-[-0.04em] text-[var(--s-ink)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Seer
        </p>
        <p className="mt-2 text-[1.05rem] font-medium text-[var(--s-ink)]">
          Fewer decisions.
        </p>
        <p className="mt-3 max-w-[18rem] text-[15px] leading-relaxed text-[var(--s-ink-soft)]">
          See what matters. Clear the rest.
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

function MailPreview({ mark }: { mark: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--s-hairline)] bg-white shadow-[0_20px_50px_-36px_rgba(11,13,16,0.4)]">
      <div className="seer-chrome-bar flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Image src={mark} alt="" width={22} height={22} unoptimized />
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
        <div className="flex gap-3 border-l-4 border-[var(--s-signal)] px-4 py-3.5">
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--s-signal)]" />
          <div className="min-w-0 flex-1">
            <div className="flex justify-between gap-3">
              <p className="truncate text-[14px] font-semibold text-[var(--s-ink)]">
                Alex Rivera
              </p>
              <p className="text-[12px] text-[var(--s-mute)]">2:14 PM</p>
            </div>
            <p className="mt-0.5 truncate text-[14px] font-medium text-[var(--s-ink)]">
              Q3 hiring — need your eyes
            </p>
            <p className="mt-0.5 truncate text-[13px] text-[var(--s-mute)]">
              Can you scan before Thursday?
            </p>
          </div>
        </div>
        <div className="flex gap-3 px-4 py-3.5">
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--s-action)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-[var(--s-ink)]">
              Stripe
            </p>
            <p className="mt-0.5 truncate text-[14px] font-medium text-[var(--s-ink)]">
              Payout of $2,480.00 on the way
            </p>
            <p className="mt-0.5 truncate text-[13px] text-[var(--s-mute)]">
              Record — archive when skimmed
            </p>
          </div>
        </div>
      </div>
      <div className="border-t border-[var(--s-hairline)] bg-[var(--s-paper-deep)]/60 px-5 py-5">
        <span className="seer-signal-chip">Act today</span>
        <p className="mt-3 text-[15px] leading-[1.65] text-[var(--s-ink-soft)]">
          Orange appears once. Everything else is ink, paper, and brand teal —
          so the eye goes where the decision is.
        </p>
      </div>
    </div>
  );
}
