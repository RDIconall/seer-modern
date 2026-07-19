import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const proximaNova = localFont({
  src: [
    { path: "../fonts/ProximaNova-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/ProximaNova-Italic.otf", weight: "400", style: "italic" },
    { path: "../fonts/ProximaNova-Semibold.otf", weight: "600", style: "normal" },
    { path: "../fonts/ProximaNova-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-proxima-nova",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Seer",
  description:
    "Seer reads your inbox and tells you what to do — reply, defer, ignore, or unsubscribe.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#1e242b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${proximaNova.variable} antialiased`}>{children}</body>
    </html>
  );
}
