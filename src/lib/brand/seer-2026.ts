/**
 * Seer 2026 — reading-first brand refresh.
 * Circle logo kept. Pure palette sharpened from the 2014 brand book.
 * Type: Klim Untitled Sans (UI/reading) + Söhne (wordmark/display).
 */

export const seer2026 = {
  name: "Seer 2026",
  focus: "Complete ease of reading",
  logo: {
    mark: "/seer-mark.png",
    note: "Circle mark unchanged — keep full-color on light grounds; B&W line mark for mono contexts.",
  },
  type: {
    ui: {
      family: "Untitled Sans",
      foundry: "Klim",
      role: "Product UI, mail list, body reading",
      stack: '"Untitled Sans", "Source Sans 3", var(--font-seer), sans-serif',
    },
    display: {
      family: "Söhne",
      foundry: "Klim",
      role: "Wordmark, section titles, empty states",
      stack: '"Söhne", "Soehne", "Source Sans 3", var(--font-seer), sans-serif',
    },
    reading: {
      size: "17px",
      lineHeight: 1.62,
      measure: "62ch",
      weight: 400,
      tracking: "0",
    },
  },
  colors: {
    /* Ink / paper — contrast first */
    ink: "#12171C",
    inkSoft: "#3D4A56",
    mute: "#5C6B78",
    hairline: "#D7DEE5",
    paper: "#FAFBFC",
    paperDeep: "#EEF2F5",
    /* Sharpened Pure (from #967ad0 / #ff8f2d / #6bcfe1 / #96d322) */
    violet: "#8B63D4",
    signal: "#FF8618",
    clear: "#14B8D4",
    lime: "#8BC91E",
    /* Brand chrome — teal pulled toward logo cyan, less muddy than #12a493 */
    brand: "#0C9B8E",
    brandDeep: "#087F74",
    brandMist: "#E2F4F1",
    /* Functional action (mail affordances) */
    action: "#2B74F0",
    actionSoft: "#D6E6FD",
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
