/**
 * Seer 2026 — reading-first brand refresh.
 * Circle logo kept. Pure palette pushed dark + dense (not pastel).
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
    /* Ink / paper — near-black type on clean paper */
    ink: "#0A0E12",
    inkSoft: "#2A333C",
    mute: "#4E5C68",
    hairline: "#C2CCD4",
    paper: "#FFFFFF",
    paperDeep: "#E6EBF0",
    /* Pure, denser — same hue family as 2014, far less pastel */
    violet: "#6B35C4",
    signal: "#E55A00",
    clear: "#008EAB",
    lime: "#5F9E00",
    /* Brand chrome — deep teal, almost inked */
    brand: "#056B62",
    brandDeep: "#044F48",
    brandMist: "#C8E4DF",
    /* Functional action */
    action: "#1452D8",
    actionSoft: "#BDD2F8",
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
