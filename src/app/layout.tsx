import type { Metadata, Viewport } from "next";
import { Roboto, Roboto_Mono } from "next/font/google";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";

/* Prior Seer (getseer.com) shipped Roboto — keep brand fidelity */
const seerSans = Roboto({
  variable: "--font-seer",
  subsets: ["latin"],
  weight: ["100", "300", "400", "500", "700"],
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
    { media: "(prefers-color-scheme: light)", color: "#3498d9" },
    { media: "(prefers-color-scheme: dark)", color: "#1e4a66" },
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
