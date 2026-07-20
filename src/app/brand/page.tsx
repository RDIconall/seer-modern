import Image from "next/image";
import Link from "next/link";
import { seer2026 } from "@/lib/brand/seer-2026";

const { colors: c, legacy: L } = seer2026;

const sharpened = [
  { name: "Ink", hex: c.ink, role: "Primary text", finish: "satin" as const },
  { name: "Ink soft", hex: c.inkSoft, role: "Body / secondary", finish: "satin" as const },
  { name: "Mute", hex: c.mute, role: "Meta — never below this", finish: "satin" as const },
  { name: "Paper", hex: c.paper, role: "Reading ground", finish: "satin" as const },
  { name: "Brand", hex: c.brand, role: "Chrome / CTAs", finish: "gloss" as const },
  { name: "Brand deep", hex: c.brandDeep, role: "Hover / pressed", finish: "gloss" as const },
  { name: "Brand mist", hex: c.brandMist, role: "Selected / soft fill", finish: "satin" as const },
  { name: "Signal", hex: c.signal, role: "Urgent / accent", finish: "gloss" as const },
  { name: "Clear", hex: c.clear, role: "Highlight / cyan", finish: "gloss" as const },
  { name: "Lime", hex: c.lime, role: "Success / sparse", finish: "gloss" as const },
  { name: "Violet", hex: c.violet, role: "Tags / unsubscribe", finish: "gloss" as const },
  { name: "Action", hex: c.action, role: "Links / send / unread", finish: "gloss" as const },
] as const;

const beforeAfter = [
  { label: "Brand teal", from: L.brand, to: c.brand },
  { label: "Orange", from: L.pure.orange, to: c.signal },
  { label: "Cyan", from: L.pure.cyan, to: c.clear },
  { label: "Green", from: L.pure.green, to: c.lime },
  { label: "Purple", from: L.pure.purple, to: c.violet },
  { label: "Body ink", from: "#3c4650", to: c.inkSoft },
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
            className="text-[1.35rem] font-medium tracking-[-0.03em] text-[var(--s-ink)]"
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

      {/* Hero — brand first, one composition, reading focus */}
      <section className="mx-auto flex min-h-[78vh] w-full max-w-6xl flex-col justify-center px-6 pb-20 pt-8 md:px-10">
        <p className="seer-2026-kicker seer-2026-rise">Seer 2026 · Brand refresh</p>
        <div className="mt-8 flex flex-col items-start gap-10 md:flex-row md:items-center md:gap-16">
          <Image
            src="/seer-mark.png"
            alt="Seer circle mark"
            width={168}
            height={168}
            className="seer-2026-mark-in shrink-0"
            priority
          />
          <div className="min-w-0">
            <h1 className="seer-2026-wordmark seer-2026-rise-delay">Seer</h1>
            <p className="seer-2026-lede seer-2026-rise-delay-2 mt-5">
              Fly through email without fighting the type. Circle mark kept.
              Pure colors sit lighter under a lacquer clear-coat — depth from
              gloss, not muddy pigment. Klim faces for reading.
            </p>
            <div className="seer-2026-rise-delay-2 mt-8 flex flex-wrap gap-3">
              <a href="#reading" className="seer-2026-cta">
                See reading system
              </a>
              <a href="#colors" className="seer-2026-cta-ghost">
                Sharpened colors
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Type */}
      <section
        id="type"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Typography · Klim</p>
        <h2 className="seer-2026-section-title mt-3">Built to be read</h2>
        <p className="seer-2026-body mt-4">
          Proxima Nova stays in the archive. The product face becomes{" "}
          <strong className="font-semibold text-[var(--s-ink)]">
            Untitled Sans
          </strong>{" "}
          for lists and message bodies, with{" "}
          <strong className="font-semibold text-[var(--s-ink)]">Söhne</strong>{" "}
          for the wordmark and quiet display moments. Sentence-case Seer —
          tracking pulled in so the eye never hunts letters.
        </p>

        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <TypeCard
            label="Display · Söhne"
            sample="Seer"
            meta="500 · −0.035em · wordmark"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 500,
              fontSize: "3.5rem",
              letterSpacing: "-0.035em",
              lineHeight: 1.05,
              color: "var(--s-ink)",
            }}
          />
          <TypeCard
            label="UI / reading · Untitled Sans"
            sample="Your inbox should feel like clear water — subjects land, bodies breathe, actions stay obvious."
            meta="400 · 17px / 1.62 · max 62ch"
            style={{
              fontFamily: "var(--font-ui)",
              fontWeight: 400,
              fontSize: "1.125rem",
              lineHeight: 1.62,
              color: "var(--s-ink-soft)",
              maxWidth: "28rem",
            }}
          />
        </div>

        <div className="mt-10 overflow-x-auto rounded-xl border border-[var(--s-hairline)] bg-white p-6 md:p-8">
          <p className="seer-2026-caption mb-5">Scale</p>
          <div className="space-y-5">
            <ScaleRow
              name="Display"
              sample="Work smarter"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "clamp(2rem, 4vw, 2.75rem)",
                fontWeight: 500,
                letterSpacing: "-0.03em",
                color: "var(--s-ink)",
              }}
            />
            <ScaleRow
              name="Title"
              sample="Inbox — triage when you need it"
              style={{
                fontSize: "1.375rem",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: "var(--s-ink)",
              }}
            />
            <ScaleRow
              name="Body"
              sample="Fly through email with your copilot — swipe cards, compose on the go, triage when you need it."
              style={{
                fontSize: "1.0625rem",
                fontWeight: 400,
                lineHeight: 1.62,
                color: "var(--s-ink-soft)",
              }}
            />
            <ScaleRow
              name="Meta"
              sample="Gmail · Outlook · Today 2:14 PM"
              style={{
                fontSize: "0.8125rem",
                fontWeight: 500,
                color: "var(--s-mute)",
              }}
            />
          </div>
          <p className="seer-2026-caption mt-6">
            Preview uses Source Sans 3 until Klim files land in{" "}
            <code className="text-[var(--s-ink)]">src/fonts/klim/</code>.
          </p>
        </div>
      </section>

      {/* Colors */}
      <section
        id="colors"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Color · lacquered Pure</p>
        <h2 className="seer-2026-section-title mt-3">Bentley clear-coat, not flat fill</h2>
        <p className="seer-2026-body mt-4">
          Mid-tone bases with a wet specular ribbon, top-edge highlight, and
          deep belly shadow — the way auto paint catches light. Hover a chip
          for the sheen pass. Reading ink stays matte so type never fights the
          chrome.
        </p>

        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {sharpened.map((swatch) => (
            <div
              key={swatch.name}
              className="seer-2026-swatch overflow-hidden rounded-xl border border-[var(--s-hairline)] bg-white"
            >
              <div
                className={
                  swatch.finish === "gloss"
                    ? "seer-gloss h-24 w-full"
                    : "seer-gloss-satin h-24 w-full"
                }
                style={{ ["--gloss" as string]: swatch.hex }}
                aria-hidden
              />
              <div className="px-3 py-2.5">
                <p className="text-sm font-semibold text-[var(--s-ink)]">
                  {swatch.name}
                </p>
                <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-[var(--s-mute)]">
                  {swatch.hex}
                  <span className="ml-1.5 normal-case tracking-normal">
                    · {swatch.finish}
                  </span>
                </p>
                <p className="mt-1 text-[12px] leading-snug text-[var(--s-ink-soft)]">
                  {swatch.role}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12">
          <p className="seer-2026-caption mb-4">2014 → 2026</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {beforeAfter.map((row) => (
              <div
                key={row.label}
                className="flex items-center gap-3 rounded-xl border border-[var(--s-hairline)] bg-white px-3 py-3"
              >
                <div className="flex overflow-hidden rounded-lg border border-[var(--s-hairline)]">
                  <div
                    className="h-12 w-12"
                    style={{ background: row.from }}
                    title={row.from}
                  />
                  <div
                    className="seer-gloss h-12 w-12"
                    style={{ ["--gloss" as string]: row.to }}
                    title={row.to}
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--s-ink)]">
                    {row.label}
                  </p>
                  <p className="truncate font-mono text-[11px] text-[var(--s-mute)]">
                    {row.from} → {row.to}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reading UI */}
      <section
        id="reading"
        className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-20 md:px-10"
      >
        <p className="seer-2026-kicker">Product · ease of reading</p>
        <h2 className="seer-2026-section-title mt-3">Where the brand earns its keep</h2>
        <p className="seer-2026-body mt-4">
          One job: make mail effortless to scan and absorb. Higher ink contrast,
          calmer chrome, subject weight that doesn’t shout, body measure capped
          so lines don’t stretch across a desktop pane.
        </p>

        <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.15fr]">
          <LoginPreview />
          <MailPreview />
        </div>

        <ul className="mt-12 grid gap-4 sm:grid-cols-3">
          <Rule
            title="Contrast"
            body="Body never uses the old mid-slate (#778591) as primary text. Mute bottoms out at #52606C."
          />
          <Rule
            title="Measure"
            body="Reading pane targets ~62 characters. List rows stay 15–16px; open messages open to 17px."
          />
          <Rule
            title="Wordmark"
            body="Sentence-case Seer beside the circle. Uppercase lockup only when the 2014 lockup sheet is required."
          />
        </ul>
      </section>

      <footer className="mx-auto w-full max-w-6xl border-t border-[var(--s-hairline)] px-6 py-10 md:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Image src="/seer-mark.png" alt="" width={28} height={28} />
            <p className="text-sm text-[var(--s-mute)]">
              Circle logo retained · Klim type · lacquered Pure
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

function TypeCard({
  label,
  sample,
  meta,
  style,
}: {
  label: string;
  sample: string;
  meta: string;
  style: React.CSSProperties;
}) {
  return (
    <div className="rounded-xl border border-[var(--s-hairline)] bg-white p-6 md:p-8">
      <p className="seer-2026-caption">{label}</p>
      <p className="mt-5" style={style}>
        {sample}
      </p>
      <p className="seer-2026-caption mt-6">{meta}</p>
    </div>
  );
}

function ScaleRow({
  name,
  sample,
  style,
}: {
  name: string;
  sample: string;
  style: React.CSSProperties;
}) {
  return (
    <div className="grid gap-2 border-b border-[var(--s-hairline)] pb-5 last:border-0 last:pb-0 md:grid-cols-[7rem_1fr]">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--s-mute)]">
        {name}
      </p>
      <p style={style}>{sample}</p>
    </div>
  );
}

function LoginPreview() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--s-hairline)] bg-white shadow-[0_24px_60px_-36px_rgba(18,23,28,0.35)]">
      <div className="seer-2026-atmosphere flex flex-col items-center px-8 py-12 text-center">
        <Image src="/seer-mark.png" alt="" width={72} height={72} />
        <p
          className="mt-5 text-[2.5rem] font-medium tracking-[-0.035em] text-[var(--s-ink)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Seer
        </p>
        <p className="mt-1 text-[1.05rem] font-medium text-[var(--s-brand)]">
          Work smarter
        </p>
        <p className="mt-4 max-w-[18rem] text-[15px] leading-relaxed text-[var(--s-ink-soft)]">
          Fly through email with your copilot — swipe cards, compose on the go.
        </p>
        <button
          type="button"
          className="seer-2026-cta mt-8 w-full max-w-[18rem]"
        >
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
    <div className="overflow-hidden rounded-2xl border border-[var(--s-hairline)] bg-white shadow-[0_24px_60px_-36px_rgba(18,23,28,0.35)]">
      <div
        className="seer-gloss-bar flex items-center justify-between px-4 py-3 text-white"
        style={{ ["--gloss" as string]: "var(--s-brand)" }}
      >
        <div className="flex items-center gap-2">
          <Image src="/seer-mark.png" alt="" width={22} height={22} />
          <span
            className="text-[1.05rem] font-medium tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Seer
          </span>
        </div>
        <span className="text-xs font-medium text-white/85">Inbox</span>
      </div>

      <div className="divide-y divide-[var(--s-hairline)]">
        <MailRow
          unread
          from="Alex Rivera"
          subject="Q3 hiring plan — need your eyes"
          preview="Can you scan the attached brief before Thursday’s sync? The role mix shifted…"
          time="2:14 PM"
        />
        <MailRow
          from="Calendar"
          subject="Reminder: design critique"
          preview="Starts in 45 minutes · Room B · Bring the latest deck"
          time="1:02 PM"
        />
        <MailRow
          from="Stripe"
          subject="Your payout of $2,480.00 is on the way"
          preview="Funds typically arrive in 1–2 business days depending on your bank."
          time="11:40 AM"
        />
      </div>

      <div className="border-t border-[var(--s-hairline)] bg-[var(--s-paper)] px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--s-mute)]">
          Reading pane
        </p>
        <h3
          className="mt-2 text-[1.2rem] font-semibold tracking-[-0.02em] text-[var(--s-ink)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Q3 hiring plan — need your eyes
        </h3>
        <p className="mt-1 text-sm text-[var(--s-mute)]">
          Alex Rivera · Today 2:14 PM
        </p>
        <p className="seer-2026-body mt-4 text-[15px]">
          Can you scan the attached brief before Thursday’s sync? The role mix
          shifted after last week’s pipeline review — two IC seats, one lead —
          and I want your read on leveling before we post.
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
  unread,
}: {
  from: string;
  subject: string;
  preview: string;
  time: string;
  unread?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 px-4 py-3.5 ${
        unread ? "bg-[var(--s-brand-mist)]/40" : "bg-white"
      }`}
    >
      <span
        className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
          unread ? "bg-[var(--s-action)]" : "bg-transparent"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p
            className={`truncate text-[14px] ${
              unread
                ? "font-semibold text-[var(--s-ink)]"
                : "font-medium text-[var(--s-ink-soft)]"
            }`}
          >
            {from}
          </p>
          <p className="shrink-0 text-[12px] text-[var(--s-mute)]">{time}</p>
        </div>
        <p
          className={`mt-0.5 truncate text-[14px] ${
            unread
              ? "font-semibold text-[var(--s-ink)]"
              : "font-medium text-[var(--s-ink-soft)]"
          }`}
        >
          {subject}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-[var(--s-mute)]">
          {preview}
        </p>
      </div>
    </div>
  );
}

function Rule({ title, body }: { title: string; body: string }) {
  return (
    <li className="rounded-xl border border-[var(--s-hairline)] bg-white px-5 py-4">
      <p className="text-sm font-semibold text-[var(--s-ink)]">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--s-ink-soft)]">
        {body}
      </p>
    </li>
  );
}
