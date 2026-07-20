/**
 * Seer — studio direction (Collins × Wolff Olins lens).
 *
 * Audience: busy professionals with decision overload.
 * Product job: triage email so they decide less, act on what matters.
 * Brand idea: "Fewer decisions."
 *
 * Circle mark kept as the only multicolor object.
 * Product surface is quiet: ink, paper, one "needs you" signal.
 * Type: Klim — Untitled Sans (reading/UI) + Söhne (wordmark/display).
 */

export const seerStudio = {
  name: "Seer",
  idea: "Fewer decisions.",
  audience: "Busy professionals with decision overload",
  job: "Triage email so they decide less and act on what matters",
  logo: {
    mark: "/seer-mark.png",
    note: "Circle mark is the only multicolor brand object. Everywhere else: restraint.",
  },
  type: {
    ui: {
      family: "Untitled Sans",
      foundry: "Klim",
      role: "Lists, bodies, chrome — long reading under stress",
    },
    display: {
      family: "Söhne",
      foundry: "Klim",
      role: "Wordmark, section titles — quiet authority, not theater",
    },
    reading: {
      size: "17px",
      lineHeight: 1.65,
      measure: "58ch",
      weight: 400,
    },
  },
  colors: {
    /* Quiet field — reading first, no washes fighting type */
    ink: "#0B0D10",
    inkSoft: "#2C333A",
    mute: "#5A6570",
    hairline: "#D4DAE0",
    paper: "#FFFFFF",
    paperDeep: "#F1F3F5",
    /* Brand — deep teal from the logo's middle ring, used sparingly */
    brand: "#0B7F74",
    brandDeep: "#08655C",
    brandMist: "#E6F3F1",
    /* Needs-you — logo orange, only for act_today / true urgency */
    signal: "#E5671A",
    /* Functional link / send — calm blue, not competing with brand */
    action: "#1F5FD1",
    actionSoft: "#E4EDFB",
    /* Semantic chips only (triage tags) — never full-bleed washes */
    violet: "#6E45B8",
    clear: "#0E9BB0",
    lime: "#6FA012",
  },
  principles: [
    {
      title: "One idea",
      body: "Fewer decisions. Every surface either reduces choice or makes the next action obvious.",
    },
    {
      title: "Circle owns color",
      body: "The mark keeps the spectrum. Product chrome stays quiet so mail can be read, not decorated.",
    },
    {
      title: "Signal is scarce",
      body: "Orange means needs you today. If everything is urgent, nothing is — Seer's job is scarcity.",
    },
    {
      title: "Type does the work",
      body: "Klim Untitled Sans for reading; Söhne for the wordmark. Sentence case. No tracked lockup in product.",
    },
  ],
} as const;

/** @deprecated alias while /brand migrates */
export const seer2026 = {
  name: seerStudio.name,
  focus: seerStudio.idea,
  logo: seerStudio.logo,
  type: {
    ui: {
      ...seerStudio.type.ui,
      stack: '"Untitled Sans", "Source Sans 3", var(--font-seer), sans-serif',
    },
    display: {
      ...seerStudio.type.display,
      stack: '"Söhne", "Soehne", "Source Sans 3", var(--font-seer), sans-serif',
    },
    reading: { ...seerStudio.type.reading, tracking: "0" },
  },
  colors: {
    ink: seerStudio.colors.ink,
    inkSoft: seerStudio.colors.inkSoft,
    mute: seerStudio.colors.mute,
    hairline: seerStudio.colors.hairline,
    paper: seerStudio.colors.paper,
    paperDeep: seerStudio.colors.paperDeep,
    violet: seerStudio.colors.violet,
    signal: seerStudio.colors.signal,
    clear: seerStudio.colors.clear,
    lime: seerStudio.colors.lime,
    brand: seerStudio.colors.brand,
    brandDeep: seerStudio.colors.brandDeep,
    brandMist: seerStudio.colors.brandMist,
    action: seerStudio.colors.action,
    actionSoft: seerStudio.colors.actionSoft,
  },
  legacy: {
    brand: "#12a493",
    pure: {
      purple: "#967ad0",
      orange: "#ff8f2d",
      cyan: "#6bcfe1",
      green: "#96d322",
    },
    dim: {
      ink: "#1e242b",
      slate: "#778591",
      mid: "#99a3ad",
      mist: "#a6bbc2",
    },
  },
} as const;

export type Seer2026 = typeof seer2026;
export type SeerStudio = typeof seerStudio;
