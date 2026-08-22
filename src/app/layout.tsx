import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppleIconScheme } from "@/components/AppleIconScheme";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";
import "./seer-skin.css";

/* Klim National 2 — UI + reading */
const seerSans = localFont({
  src: [
    { path: "../fonts/klim/National2-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/klim/National2-Medium.otf", weight: "500", style: "normal" },
    { path: "../fonts/klim/National2-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-seer",
  display: "swap",
});

/* Tiempos Headline — the one display face, for a single headline per screen */
const seerDisplay = localFont({
  src: [
    { path: "../fonts/klim/TiemposHeadline-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/klim/TiemposHeadline-Medium.otf", weight: "500", style: "normal" },
  ],
  variable: "--font-seer-display",
  display: "swap",
});

/* Söhne Mono — tabular numerals for counts, ages, amounts, study codes */
const seerMono = localFont({
  src: [
    { path: "../fonts/klim/SohneMono-Buch.otf", weight: "400", style: "normal" },
    { path: "../fonts/klim/SohneMono-Kraftig.otf", weight: "600", style: "normal" },
  ],
  variable: "--font-seer-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Seer",
  description: "Fewer decisions — fly through email with your copilot",
  applicationName: "Seer",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Seer",
  },
  icons: {
    // Browsers honour `media` on a favicon, so the dark tile is declared here
    // and chosen without any script. The Apple touch icon cannot be declared
    // twice — Safari ignores `media` and would just take one of them — so it is
    // switched at runtime by `AppleIconScheme`.
    icon: [
      {
        url: "/favicon.png",
        sizes: "32x32",
        type: "image/png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/favicon-dark.png",
        sizes: "32x32",
        type: "image/png",
        media: "(prefers-color-scheme: dark)",
      },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0B7F74" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0D10" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${seerSans.variable} ${seerDisplay.variable} ${seerMono.variable} antialiased`}
      >
        {children}
        <AppleIconScheme />
        <PwaRegister />
      </body>
    </html>
  );
}
