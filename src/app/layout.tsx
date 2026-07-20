import type { Metadata, Viewport } from "next";
import { Roboto_Mono, Source_Sans_3 } from "next/font/google";
import localFont from "next/font/local";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";

/**
 * Studio type: Klim Untitled Sans / Söhne when files land in src/fonts/klim/.
 * Source Sans 3 is the reading stand-in; Proxima remains a local fallback.
 */
const seerUi = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-seer",
  display: "swap",
});

const seerLegacy = localFont({
  src: [
    { path: "../fonts/ProximaNova-Light.otf", weight: "300", style: "normal" },
    { path: "../fonts/ProximaNova-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/ProximaNova-Italic.otf", weight: "400", style: "italic" },
    { path: "../fonts/ProximaNova-Semibold.otf", weight: "600", style: "normal" },
    { path: "../fonts/ProximaNova-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-seer-legacy",
  display: "swap",
});

const seerMono = Roboto_Mono({
  variable: "--font-seer-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Seer",
  description: "Fewer decisions — fly through email with your copilot",
  applicationName: "Seer",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
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
        className={`${seerUi.variable} ${seerLegacy.variable} ${seerMono.variable} antialiased`}
      >
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
