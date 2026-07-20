import { Source_Sans_3 } from "next/font/google";
import type { Metadata } from "next";
import "./brand-2026.css";

/**
 * Klim Untitled Sans / Söhne are the target faces (see src/fonts/klim/README.md).
 * Source Sans 3 stands in until those licensed files are dropped in — same job:
 * quiet neo-grotesque, built for long reading.
 */
const seerUi = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-seer-ui",
  display: "swap",
});

const seerDisplay = Source_Sans_3({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-seer-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Seer 2026 — Brand refresh",
  description:
    "Reading-first Seer brand refresh: circle logo kept, Klim type, sharpened Pure colors.",
};

export default function BrandLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`seer-2026 ${seerUi.variable} ${seerDisplay.variable} min-h-screen`}
    >
      {children}
    </div>
  );
}
