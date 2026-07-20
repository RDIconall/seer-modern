import localFont from "next/font/local";
import type { Metadata } from "next";
import "./brand-2026.css";

const seerUi = localFont({
  src: [
    { path: "../../fonts/klim/National2-Regular.otf", weight: "400", style: "normal" },
    { path: "../../fonts/klim/National2-Medium.otf", weight: "500", style: "normal" },
    { path: "../../fonts/klim/National2-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-seer-ui",
  display: "swap",
});

const seerDisplay = localFont({
  src: [
    {
      path: "../../fonts/klim/TiemposHeadline-Regular.otf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/klim/TiemposHeadline-Medium.otf",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-seer-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Seer — Studio brand direction",
  description:
    "Fewer decisions. Collins × Wolff Olins lens for Seer — Klim National 2 + Tiempos Headline.",
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
