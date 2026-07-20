import { Source_Sans_3 } from "next/font/google";
import type { Metadata } from "next";
import "./brand-2026.css";

/**
 * Klim Untitled Sans / Söhne are the target faces (see src/fonts/klim/README.md).
 * Source Sans 3 stands in until those files are dropped in.
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
  title: "Seer — Studio brand direction",
  description:
    "Fewer decisions. Collins × Wolff Olins lens for Seer — Klim type, quiet field, scarce signal.",
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
