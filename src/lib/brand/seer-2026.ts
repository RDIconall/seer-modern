/**
 * Seer 2026 — reading-first brand refresh.
 * Circle logo kept. Pure colors: lighter mid-tones under a uniform clear-coat
 * (even lacquer — no specular hotspots). Type: Klim Untitled Sans + Söhne.
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
    /* Ink / paper — reading stays matte-crisp; chroma gets the lacquer */
    ink: "#0A0E12",
    inkSoft: "#2A333C",
    mute: "#52606C",
    hairline: "#C5CED6",
    paper: "#FFFFFF",
    paperDeep: "#E8EDF2",
    /* Pure mid-tones — gloss supplies the depth */
    violet: "#8A52D8",
    signal: "#FF7A1F",
    clear: "#1AB8D4",
    lime: "#8BC91A",
    brand: "#0F9A8C",
    brandDeep: "#0A7A70",
    brandMist: "#D5F0EB",
    action: "#2B6FF0",
    actionSoft: "#D0E2FC",
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
