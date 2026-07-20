/**
 * Seer — studio color + mark direction (Collins × Wolff Olins).
 *
 * Idea: Fewer decisions. / Seeing what matters.
 * Palette is ruthlessly small. Circle eye kept, reskinned to ≤3 hues.
 */

export const seerStudio = {
  name: "Seer",
  idea: "Fewer decisions.",
  metaphor: "Seeing what matters.",
  audience: "Busy professionals with decision overload",
  job: "Triage email so they decide less and act on what matters",
  logo: {
    legacy: "/seer-mark.png",
    recommended: "/seer-mark.png",
    options: [
      {
        id: "dual",
        src: "/seer-mark-dual.svg",
        title: "Dual — recommended (live)",
        note: "Cool gray outer, brand teal iris, ink pupil. Now the app mark.",
      },
      {
        id: "brand",
        src: "/seer-mark-brand.svg",
        title: "Brand",
        note: "Ownable teal field + ink core. Wolff Olins one-color culture.",
      },
      {
        id: "focus",
        src: "/seer-mark-focus.svg",
        title: "Focus",
        note: "Teal rings + signal pupil. The orange is literally what needs you.",
      },
      {
        id: "mono",
        src: "/seer-mark-mono.svg",
        title: "Mono",
        note: "Ink-only. Collins reduction for print, legal, one-color apps.",
      },
      {
        id: "line",
        src: "/seer-mark-line.svg",
        title: "Line",
        note: "Stroke eye for favicon / watermark. Same geometry.",
      },
    ],
  },
  type: {
    ui: {
      family: "Untitled Sans",
      foundry: "Klim",
      role: "Lists, bodies, chrome",
    },
    display: {
      family: "Söhne",
      foundry: "Klim",
      role: "Wordmark, titles",
    },
    reading: {
      size: "17px",
      lineHeight: 1.65,
      measure: "58ch",
      weight: 400,
    },
  },
  /** The colors they would actually ship */
  colors: {
    ink: "#0B0D10",
    inkSoft: "#2C333A",
    mute: "#5A6570",
    hairline: "#D4DAE0",
    paper: "#FFFFFF",
    field: "#F1F3F5",
    brand: "#0B7F74",
    brandMid: "#14A090",
    brandDeep: "#08655C",
    brandSoft: "#E6F3F1",
    signal: "#E5671A",
    action: "#1F5FD1",
  },
  principles: [
    {
      title: "Six colors, not sixteen",
      body: "Ink, paper, field, brand, signal, action. Everything else is a tint of those.",
    },
    {
      title: "Eye keeps the metaphor",
      body: "Same three-ring, three-wedge geometry — reskinned so the pupil is the focus, not a rainbow.",
    },
    {
      title: "Signal is scarce",
      body: "Orange only for needs-you-today (and optionally the Focus mark pupil). Never decoration.",
    },
    {
      title: "Brand owns teal",
      body: "One cultural color from the old middle ring. Chrome, CTAs, selected state — that’s it.",
    },
  ],
} as const;

/** Back-compat for existing imports */
export const seer2026 = {
  name: seerStudio.name,
  focus: seerStudio.idea,
  logo: {
    mark: seerStudio.logo.recommended,
    note: seerStudio.logo.options[0].note,
  },
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
    paperDeep: seerStudio.colors.field,
    violet: "#6E45B8",
    signal: seerStudio.colors.signal,
    clear: seerStudio.colors.brandMid,
    lime: "#6FA012",
    brand: seerStudio.colors.brand,
    brandDeep: seerStudio.colors.brandDeep,
    brandMist: seerStudio.colors.brandSoft,
    action: seerStudio.colors.action,
    actionSoft: "#E4EDFB",
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
