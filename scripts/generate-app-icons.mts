/**
 * Render every launcher icon Seer ships, in a light and a dark scheme.
 *
 * The mark is the same three-ring, three-wedge eye the app draws in
 * `SeerMark.tsx`; only the palette and the ground change between schemes. The
 * icons are generated rather than hand-exported so the two schemes cannot drift
 * apart, and so a palette change is a one-line edit followed by a rerun.
 *
 *   npx tsx scripts/generate-app-icons.mts
 *
 * Grounds are opaque on purpose. iOS composites a transparent home-screen icon
 * onto BLACK, so a transparent export is not "adaptive" — it is a dark icon you
 * did not design, and it made the ink pupil disappear into the tile.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/** The eye, in the 256×256 space the brand marks are drawn in. */
const OUTER_RING = [
  "M 128 10 A 118 118 0 0 1 230.191 187 L 195.55 167 A 78 78 0 0 0 128 50 Z",
  "M 230.191 187 A 118 118 0 0 1 25.809 187 L 60.45 167 A 78 78 0 0 0 195.55 167 Z",
  "M 25.809 187 A 118 118 0 0 1 128 10 L 128 50 A 78 78 0 0 0 60.45 167 Z",
];
const IRIS = [
  "M 128 50 A 78 78 0 0 1 195.55 167 L 160.909 147 A 38 38 0 0 0 128 90 Z",
  "M 195.55 167 A 78 78 0 0 1 60.45 167 L 95.091 147 A 38 38 0 0 0 160.909 147 Z",
  "M 60.45 167 A 78 78 0 0 1 128 50 L 128 90 A 38 38 0 0 0 95.091 147 Z",
];
const PUPIL = [
  "M 128 128 L 128 90 A 38 38 0 0 1 160.909 147 Z",
  "M 128 128 L 160.909 147 A 38 38 0 0 1 95.091 147 Z",
  "M 128 128 L 95.091 147 A 38 38 0 0 1 128 90 Z",
];

/** The mark's outer circle is 236 wide inside its 256 box. */
const MARK_DIAMETER = 236;

type Scheme = "light" | "dark";

type Palette = {
  ground: string;
  outer: [string, string, string];
  iris: [string, string, string];
  pupil: string;
};

/**
 * Light is the studio palette unchanged: a cool grey ring, brand teal iris, ink
 * pupil, on the field grey the app already uses behind paper.
 *
 * Dark is not an inversion. Inverting would put a near-white ring on the tile
 * and make the icon the brightest thing on a dark home screen. Instead the ring
 * steps down into slate, the iris steps UP into the dark-theme teals so the
 * brand still carries the mark, and the pupil stays the darkest element — it
 * reads as a hole cut through to the tile because the teal iris rings it.
 */
const PALETTES: Record<Scheme, Palette> = {
  light: {
    ground: "#F1F3F5",
    outer: ["#DDE3E6", "#C5CED4", "#AEB8C0"],
    iris: ["#14A090", "#0B7F74", "#08655C"],
    pupil: "#0B0D10",
  },
  dark: {
    ground: "#0B0D10",
    outer: ["#46515C", "#36404A", "#28313A"],
    iris: ["#2ABBA9", "#17A595", "#0F857A"],
    pupil: "#05070A",
  },
};

type Target = {
  file: string;
  size: number;
  scheme: Scheme;
  /** The eye's diameter as a fraction of the tile. */
  markScale: number;
};

/**
 * `apple` and `maskable` keep the mark smaller because both are masked by the
 * platform — iOS rounds the tile into a squircle, and Android may crop a
 * maskable icon to any shape inside the middle 80%.
 */
const TARGETS: Target[] = [
  { file: "public/icons/apple-touch-icon.png", size: 180, scheme: "light", markScale: 0.72 },
  { file: "public/icons/apple-touch-icon-dark.png", size: 180, scheme: "dark", markScale: 0.72 },
  { file: "public/icons/icon-192.png", size: 192, scheme: "light", markScale: 0.78 },
  { file: "public/icons/icon-192-dark.png", size: 192, scheme: "dark", markScale: 0.78 },
  { file: "public/icons/icon-512.png", size: 512, scheme: "light", markScale: 0.78 },
  { file: "public/icons/icon-512-dark.png", size: 512, scheme: "dark", markScale: 0.78 },
  { file: "public/icons/icon-512-maskable.png", size: 512, scheme: "light", markScale: 0.68 },
  { file: "public/icons/icon-512-maskable-dark.png", size: 512, scheme: "dark", markScale: 0.68 },
  { file: "public/favicon.png", size: 32, scheme: "light", markScale: 0.88 },
  { file: "public/favicon-dark.png", size: 32, scheme: "dark", markScale: 0.88 },
  // Next's file conventions serve these routes too; keep them the same art.
  { file: "src/app/apple-icon.png", size: 180, scheme: "light", markScale: 0.72 },
  { file: "src/app/icon.png", size: 512, scheme: "light", markScale: 0.78 },
];

function markSvg(size: number, scheme: Scheme, markScale: number): string {
  const palette = PALETTES[scheme];
  const k = (size * markScale) / MARK_DIAMETER;
  const offset = size / 2 - 128 * k;
  const wedges = [
    ...OUTER_RING.map((d, i) => ({ d, fill: palette.outer[i] })),
    ...IRIS.map((d, i) => ({ d, fill: palette.iris[i] })),
    ...PUPIL.map((d) => ({ d, fill: palette.pupil })),
  ];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${palette.ground}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${k})">`,
    ...wedges.map((w) => `<path d="${w.d}" fill="${w.fill}"/>`),
    `</g>`,
    `</svg>`,
  ].join("");
}

async function main(): Promise<void> {
  for (const target of TARGETS) {
    const svg = markSvg(target.size, target.scheme, target.markScale);
    const png = await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      // The ground is already opaque; flattening states the guarantee that iOS
      // depends on rather than trusting the renderer to have kept it.
      .flatten({ background: PALETTES[target.scheme].ground })
      .toBuffer();
    await fs.mkdir(path.dirname(target.file), { recursive: true });
    await fs.writeFile(target.file, png);
    console.log(`${target.file} — ${target.size}px ${target.scheme}`);
  }
}

await main();
