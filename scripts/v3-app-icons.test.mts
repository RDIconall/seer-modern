/**
 * Gate: the launcher icons ship in both schemes, and every tile is opaque.
 *
 * iOS composites a transparent home-screen icon onto BLACK. Seer's icons were
 * exported with transparent corners, so the "light" tile was already being
 * shown as a mark floating on a black square — with an ink pupil that vanished
 * into it. A dark variant is meaningless until the light one is a real light
 * tile, so both facts are pinned here.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import sharp from "sharp";

type Probe = {
  width: number;
  height: number;
  transparentPixels: number;
  corner: number[];
  centre: number[];
};

async function probe(file: string): Promise<Probe> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return Array.from(data.slice(i, i + info.channels));
  };
  let transparentPixels = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] !== 255) transparentPixels += 1;
  }
  return {
    width: info.width,
    height: info.height,
    transparentPixels,
    corner: at(1, 1),
    centre: at(info.width >> 1, info.height >> 1),
  };
}

const FIELD = [241, 243, 245];
const INK = [11, 13, 16];

const PAIRS = [
  { light: "public/icons/apple-touch-icon.png", dark: "public/icons/apple-touch-icon-dark.png", size: 180 },
  { light: "public/icons/icon-192.png", dark: "public/icons/icon-192-dark.png", size: 192 },
  { light: "public/icons/icon-512.png", dark: "public/icons/icon-512-dark.png", size: 512 },
  { light: "public/icons/icon-512-maskable.png", dark: "public/icons/icon-512-maskable-dark.png", size: 512 },
  { light: "public/favicon.png", dark: "public/favicon-dark.png", size: 32 },
];

for (const pair of PAIRS) {
  const light = await probe(pair.light);
  const dark = await probe(pair.dark);

  for (const [file, shot] of [
    [pair.light, light],
    [pair.dark, dark],
  ] as const) {
    assert.equal(shot.width, pair.size, `${file} must be ${pair.size}px wide`);
    assert.equal(shot.height, pair.size, `${file} must be ${pair.size}px tall`);
    assert.equal(
      shot.transparentPixels,
      0,
      `${file} must be fully opaque — iOS composites transparency onto black`,
    );
  }

  // The two schemes must actually be different tiles, not the same art twice.
  const lightBytes = await fs.readFile(pair.light);
  const darkBytes = await fs.readFile(pair.dark);
  assert.ok(
    !lightBytes.equals(darkBytes),
    `${pair.dark} must differ from ${pair.light}`,
  );

  // Ground: the light tile sits on field grey, the dark tile on ink.
  assert.deepEqual(light.corner.slice(0, 3), FIELD, `${pair.light} ground`);
  assert.deepEqual(dark.corner.slice(0, 3), INK, `${pair.dark} ground`);

  // And a dark tile must be darker than its light twin, or it is not a dark
  // icon — it is the same icon on a different file name.
  const luminance = (rgb: number[]) =>
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  assert.ok(
    luminance(dark.corner) < luminance(light.corner),
    `${pair.dark} must be darker than ${pair.light}`,
  );
}

// The generator is the only source of these files, so it has to stay runnable.
const generator = await fs.readFile("scripts/generate-app-icons.mts", "utf8");
assert.match(generator, /apple-touch-icon-dark\.png/);
assert.match(generator, /PALETTES/);

// Favicons pick their scheme declaratively; the Apple tile cannot.
const layout = await fs.readFile("src/app/layout.tsx", "utf8");
assert.match(layout, /favicon-dark\.png/);
assert.match(layout, /prefers-color-scheme: dark/);
assert.match(layout, /<AppleIconScheme \/>/);
const appleLinks = layout.match(/apple: \[[^\]]*\]/)?.[0] ?? "";
assert.ok(
  !appleLinks.includes("apple-touch-icon-dark"),
  "Safari ignores media on apple-touch-icon; declaring both would let iOS take either",
);

const swap = await fs.readFile("src/components/AppleIconScheme.tsx", "utf8");
assert.match(swap, /prefers-color-scheme: dark/);
assert.match(swap, /apple-touch-icon-dark\.png/);
assert.match(swap, /addEventListener\("change"/);

console.log("v3-app-icons: OK");
