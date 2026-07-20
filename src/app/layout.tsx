import type { Metadata, Viewport } from "next";
import { Roboto_Mono } from "next/font/google";
import localFont from "next/font/local";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";

/* Proxima Nova — the brand typeface from the Seer brand guidelines (1.3) */
const seerSans = localFont({
  src: [
    { path: "../fonts/ProximaNova-Light.otf", weight: "300", style: "normal" },
    { path: "../fonts/ProximaNova-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/ProximaNova-Italic.otf", weight: "400", style: "italic" },
    { path: "../fonts/ProximaNova-Semibold.otf", weight: "600", style: "normal" },
    { path: "../fonts/ProximaNova-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-seer",
  display: "swap",
});

const seerMono = Roboto_Mono({
  variable: "--font-seer-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Seer",
  description: "Work smarter — fly through email with your copilot",
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
    { media: "(prefers-color-scheme: light)", color: "#12a493" },
    { media: "(prefers-color-scheme: dark)", color: "#1e242b" },
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
        className={`${seerSans.variable} ${seerMono.variable} antialiased`}
      >
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
